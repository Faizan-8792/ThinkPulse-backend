"use strict";

const express = require("express");

const {
  ALLOWED_AMOUNTS_INR,
  MIN_WALLET_TOPUP_INR,
  MAX_WALLET_TOPUP_INR,
  fromPaise,
  normalizeAmountInr,
  normalizeWalletTopupAmountInr,
  resolvePlanByAmount
} = require("../payments/amounts");
const {
  isConfigured: isRazorpayConfigured,
  getPublicKeyId,
  createOrder,
  createSingleUseQr,
  fetchQrCode,
  fetchOrder,
  fetchPayment,
  verifyPaymentSignature,
  verifyWebhookSignature
} = require("../payments/razorpay_client");
const {
  isConfigured: isSupabaseConfigured,
  verifyPaymentsTableAccess,
  upsertPaymentRecord,
  markUserAsPaid
} = require("../payments/supabase_store");

const router = express.Router();

/**
 * Converts unknown value to a safe short string.
 * @param {unknown} value
 * @param {number} maxLength
 * @returns {string}
 */
function toSafeString(value, maxLength = 180) {
  return String(value || "").trim().slice(0, maxLength);
}

/**
 * Returns first available user identifier from payload-like object.
 * @param {Record<string, unknown>|null|undefined} value
 * @returns {string}
 */
function pickUserId(value) {
  const source = value && typeof value === "object" ? value : {};
  const candidates = [
    source.userId,
    source.user_id,
    source.uid,
    source.email,
    source.customerEmail,
    source.customer_email
  ];

  for (const candidate of candidates) {
    const safe = toSafeString(candidate, 180);
    if (safe) {
      return safe;
    }
  }

  return "";
}

/**
 * Returns true if status means payment succeeded.
 * @param {string} status
 * @returns {boolean}
 */
function isSuccessStatus(status) {
  const safe = String(status || "").trim().toLowerCase();
  return safe === "captured" || safe === "paid";
}

/**
 * Normalizes amount from request or payment entity.
 * @param {unknown} reqAmountInr
 * @param {unknown} paiseAmount
 * @returns {number|null}
 */
function resolveAmountInr(reqAmountInr, paiseAmount) {
  const directFixed = normalizeAmountInr(reqAmountInr);
  if (directFixed) {
    return directFixed;
  }

  const directTopup = normalizeWalletTopupAmountInr(reqAmountInr);
  if (directTopup) {
    return directTopup;
  }

  const fromPayment = fromPaise(paiseAmount);
  const normalizedFromPayment =
    normalizeAmountInr(fromPayment) || normalizeWalletTopupAmountInr(fromPayment);
  return normalizedFromPayment || null;
}

/**
 * Extracts safe provider error details for API responses.
 * @param {any} error
 * @returns {{statusCode:number|null,description:string,providerCode:string,providerReason:string}}
 */
function extractProviderErrorDetails(error) {
  const statusCode = Number(error?.statusCode);
  const safeStatusCode = Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 600
    ? statusCode
    : null;

  return {
    statusCode: safeStatusCode,
    description: toSafeString(error?.error?.description || error?.message || "", 220),
    providerCode: toSafeString(error?.error?.code || "", 80),
    providerReason: toSafeString(error?.error?.reason || "", 120)
  };
}

/**
 * Persists paid payment and updates user plan state.
 * @param {{userId:string,paymentId:string,status:string,amountInr:number,createdAt?:number|string|Date}} payload
 * @returns {Promise<{stored:boolean,row?:object,userUpdated?:boolean,userReason?:string}>}
 */
async function persistPaymentAndPlan(payload) {
  const userId = toSafeString(payload?.userId, 180);
  const paymentId = toSafeString(payload?.paymentId, 120);
  const status = toSafeString(payload?.status, 40).toLowerCase() || "captured";
  const amountInr = Number(payload?.amountInr);

  if (!paymentId) {
    throw new Error("paymentId is required to persist payment.");
  }
  if (!Number.isFinite(amountInr) || amountInr <= 0) {
    throw new Error("amountInr must be a positive number.");
  }

  const storage = await upsertPaymentRecord({
    userId,
    paymentId,
    status,
    amountInr,
    createdAt: payload?.createdAt
  });

  let userUpdate = {
    updated: false,
    reason: "Payment is not in successful status."
  };

  if (userId && isSuccessStatus(status)) {
    const plan = resolvePlanByAmount(amountInr) || "basic";
    userUpdate = await markUserAsPaid({ userId, plan });
  }

  return {
    stored: storage.stored,
    row: storage.row,
    userUpdated: Boolean(userUpdate.updated),
    userReason: userUpdate.reason || ""
  };
}

router.post("/create-order", async (req, res) => {
  if (!isRazorpayConfigured()) {
    res.status(503).json({
      ok: false,
      error: "Razorpay is not configured on the server."
    });
    return;
  }

  const amountInr = normalizeAmountInr(req.body?.amount);
  if (!amountInr) {
    res.status(400).json({
      ok: false,
      error: `amount must be one of: ${ALLOWED_AMOUNTS_INR.join(", ")}`
    });
    return;
  }

  const userId = pickUserId(req.body);
  if (!userId) {
    res.status(400).json({
      ok: false,
      error: "userId (or email) is required."
    });
    return;
  }

  try {
    const order = await createOrder({
      amountInr,
      userId,
      notes: req.body?.notes
    });

    res.status(201).json({
      ok: true,
      keyId: getPublicKeyId(),
      order
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error?.message || "Unable to create Razorpay order."
    });
  }
});

router.get("/create-qr", (_req, res) => {
  res.status(405).json({
    ok: false,
    error: "Use POST /create-qr with JSON body.",
    expectedBody: {
      amount: ALLOWED_AMOUNTS_INR[0],
      userId: "user@example.com"
    }
  });
});

router.post("/create-qr", async (req, res) => {
  if (!isRazorpayConfigured()) {
    res.status(503).json({
      ok: false,
      error: "Razorpay is not configured on the server."
    });
    return;
  }

  const kind = String(req.body?.kind || "plan_purchase").trim().toLowerCase() === "wallet_topup"
    ? "wallet_topup"
    : "plan_purchase";
  const amountInr = kind === "wallet_topup"
    ? normalizeWalletTopupAmountInr(req.body?.amount)
    : normalizeAmountInr(req.body?.amount);
  if (!amountInr) {
    res.status(400).json({
      ok: false,
      error:
        kind === "wallet_topup"
          ? `amount must be a whole number between ${MIN_WALLET_TOPUP_INR} and ${MAX_WALLET_TOPUP_INR}`
          : `amount must be one of: ${ALLOWED_AMOUNTS_INR.join(", ")}`
    });
    return;
  }

  const userId = pickUserId(req.body);
  if (!userId) {
    res.status(400).json({
      ok: false,
      error: "userId (or email) is required."
    });
    return;
  }

  try {
    const qr = await createSingleUseQr({
      amountInr,
      userId,
      allowCustomAmount: kind === "wallet_topup",
      kind,
      description: toSafeString(
        req.body?.description ||
          (kind === "wallet_topup"
            ? `ThinkPulse wallet top-up Rs ${amountInr}`
            : `ThinkPulse ${amountInr === 20 ? "Premium" : "Basic"} plan Rs ${amountInr}`),
        180
      )
    });

    const qrId = toSafeString(qr?.id, 140);
    const orderId = toSafeString(qr?.order_id || qr?.orderId, 140);
    const imageUrl = toSafeString(qr?.image_url || qr?.imageUrl, 2000);
    const upiIntent = toSafeString(qr?.payment_url || qr?.upiIntent || qr?.upi_intent, 2000);
    const amountPaise = Math.max(0, Number(qr?.payment_amount || qr?.amount || Math.round(amountInr * 100)));
    const safeAmountInr = Number(fromPaise(amountPaise)) || amountInr;
    const closeBy = Math.max(0, Number(qr?.close_by || qr?.closeBy) || 0);
    const createdAtSec = Math.max(0, Number(qr?.created_at || qr?.createdAt) || 0);
    const amountReceivedPaise = Math.max(0, Number(qr?.payments_amount_received) || 0);
    const paymentsCountReceived = Math.max(0, Number(qr?.payments_count_received) || 0);

    res.status(201).json({
      ok: true,
      qr: {
        id: qrId,
        orderId,
        imageUrl,
        upiIntent,
        status: String(qr?.status || "created").toLowerCase(),
        closeBy,
        closeByMs: closeBy > 0 ? closeBy * 1000 : 0,
        createdAt: createdAtSec > 0 ? createdAtSec * 1000 : Date.now(),
        amountPaise,
        amountInr: safeAmountInr,
        amountReceivedPaise,
        paymentsCountReceived,
        currency: toSafeString(qr?.currency || "INR", 10) || "INR",
        kind
      }
    });
  } catch (error) {
    const providerError = extractProviderErrorDetails(error);
    const responseStatus = providerError.statusCode || 500;

    res.status(responseStatus).json({
      ok: false,
      error: providerError.description || "Unable to create dynamic QR.",
      providerError: {
        code: providerError.providerCode || "UNKNOWN",
        reason: providerError.providerReason || "NA",
        statusCode: responseStatus
      }
    });
  }
});

router.get("/qr-status/:qrId", async (req, res) => {
  if (!isRazorpayConfigured()) {
    res.status(503).json({
      ok: false,
      error: "Razorpay is not configured on the server."
    });
    return;
  }

  const qrId = toSafeString(req.params?.qrId, 120);
  if (!qrId) {
    res.status(400).json({
      ok: false,
      error: "qrId route param is required."
    });
    return;
  }

  const requesterUserId = pickUserId(req.query);

  try {
    const isOrderReference = qrId.startsWith("order_");

    if (isOrderReference) {
      const order = await fetchOrder(qrId);
      const orderUserId = pickUserId(order?.notes);

      if (
        requesterUserId &&
        orderUserId &&
        requesterUserId.toLowerCase() !== orderUserId.toLowerCase()
      ) {
        res.status(403).json({
          ok: false,
          error: "Order does not belong to requested user."
        });
        return;
      }

      const orderStatus = toSafeString(order?.status, 40).toLowerCase() || "created";
      const kind = toSafeString(order?.notes?.kind, 40).toLowerCase() || "plan_purchase";
      const amountPaise = Math.max(0, Number(order?.amount) || 0);
      const amountReceivedPaise = Math.max(0, Number(order?.amount_paid) || 0);
      const paymentsCountReceived = amountReceivedPaise > 0 ? 1 : 0;
      const amountInr = resolveAmountInr(null, amountPaise);
      const paid = Boolean(
        orderStatus === "paid" &&
          amountPaise > 0 &&
          amountReceivedPaise >= amountPaise
      );

      let persistence = null;
      if (paid && amountInr) {
        persistence = await persistPaymentAndPlan({
          userId: orderUserId || requesterUserId,
          paymentId: `order_${qrId}`,
          status: "captured",
          amountInr,
          createdAt: order?.created_at
        });
      }

      res.json({
        ok: true,
        paid,
        qr: {
          id: qrId,
          status: paid ? "closed" : orderStatus,
          closeBy: 0,
          closedAt: 0,
          closeReason: "",
          amountPaise,
          amountInr: amountInr || null,
          amountReceivedPaise,
          paymentsCountReceived,
          userId: orderUserId || "",
          kind
        },
        payment: paid
          ? {
            id: `order_${qrId}`,
            status: "captured",
            amountInr: amountInr || null,
            userId: orderUserId || requesterUserId || "",
            kind
          }
          : null,
        persistence
      });
      return;
    }

    const qr = await fetchQrCode(qrId);
    const qrUserId = pickUserId(qr?.notes);

    if (
      requesterUserId &&
      qrUserId &&
      requesterUserId.toLowerCase() !== qrUserId.toLowerCase()
    ) {
      res.status(403).json({
        ok: false,
        error: "QR does not belong to requested user."
      });
      return;
    }

    const qrStatus = toSafeString(qr?.status, 40).toLowerCase() || "unknown";
    const kind = toSafeString(qr?.notes?.kind, 40).toLowerCase() || "plan_purchase";
    const amountPaise = Math.max(0, Number(qr?.payment_amount) || 0);
    const amountReceivedPaise = Math.max(0, Number(qr?.payments_amount_received) || 0);
    const paymentsCountReceived = Math.max(0, Number(qr?.payments_count_received) || 0);
    const amountInr = resolveAmountInr(null, amountPaise);
    const paid = Boolean(
      (qrStatus === "closed" || qrStatus === "paid") &&
        amountPaise > 0 &&
        paymentsCountReceived > 0 &&
        amountReceivedPaise >= amountPaise
    );

    let persistence = null;
    if (paid && amountInr) {
      persistence = await persistPaymentAndPlan({
        userId: qrUserId || requesterUserId,
        paymentId: `qr_${qrId}`,
        status: "captured",
        amountInr,
        createdAt: qr?.closed_at || qr?.created_at
      });
    }

    res.json({
      ok: true,
      paid,
      qr: {
        id: qrId,
        status: qrStatus,
        closeBy: Number(qr?.close_by) || 0,
        closedAt: Number(qr?.closed_at) || 0,
        closeReason: toSafeString(qr?.close_reason, 80) || "",
        amountPaise,
        amountInr: amountInr || null,
        amountReceivedPaise,
        paymentsCountReceived,
        userId: qrUserId || "",
        kind
      },
      payment: paid
        ? {
          id: `qr_${qrId}`,
          status: "captured",
          amountInr: amountInr || null,
          userId: qrUserId || requesterUserId || "",
          kind
        }
        : null,
      persistence
    });
  } catch (error) {
    const providerError = extractProviderErrorDetails(error);
    const responseStatus = providerError.statusCode || 500;

    res.status(responseStatus).json({
      ok: false,
      error: providerError.description || "Unable to fetch QR status.",
      providerError: {
        code: providerError.providerCode || "UNKNOWN",
        reason: providerError.providerReason || "NA",
        statusCode: responseStatus
      }
    });
  }
});

router.post("/verify-payment", async (req, res) => {
  if (!isRazorpayConfigured()) {
    res.status(503).json({
      ok: false,
      error: "Razorpay is not configured on the server."
    });
    return;
  }

  const orderId = toSafeString(req.body?.razorpay_order_id || req.body?.orderId, 120);
  const paymentId = toSafeString(req.body?.razorpay_payment_id || req.body?.paymentId, 120);
  const signature = toSafeString(req.body?.razorpay_signature || req.body?.signature, 200);

  if (!orderId || !paymentId || !signature) {
    res.status(400).json({
      ok: false,
      error: "razorpay_order_id, razorpay_payment_id, and razorpay_signature are required."
    });
    return;
  }

  const verified = verifyPaymentSignature({
    orderId,
    paymentId,
    signature
  });

  if (!verified) {
    res.status(400).json({
      ok: false,
      verified: false,
      error: "Invalid payment signature."
    });
    return;
  }

  try {
    let paymentDetails = null;
    try {
      paymentDetails = await fetchPayment(paymentId);
      if (paymentDetails?.order_id && paymentDetails.order_id !== orderId) {
        res.status(400).json({
          ok: false,
          verified: false,
          error: "Order mismatch for payment verification."
        });
        return;
      }
    } catch (fetchError) {
      paymentDetails = null;
    }

    const amountInr = resolveAmountInr(req.body?.amount, paymentDetails?.amount);
    if (!amountInr) {
      res.status(400).json({
        ok: false,
        verified: false,
        error: `amount must be one of: ${ALLOWED_AMOUNTS_INR.join(", ")}`
      });
      return;
    }

    const userId = pickUserId(req.body) || pickUserId(paymentDetails?.notes);
    if (!userId) {
      res.status(400).json({
        ok: false,
        verified: false,
        error: "userId (or email) is required for payment persistence."
      });
      return;
    }

    const status = toSafeString(paymentDetails?.status || "captured", 40).toLowerCase();
    const persistence = await persistPaymentAndPlan({
      userId,
      paymentId,
      status,
      amountInr,
      createdAt: paymentDetails?.created_at
    });

    res.json({
      ok: true,
      verified: true,
      payment: {
        orderId,
        paymentId,
        status,
        amountInr,
        currency: "INR"
      },
      persistence
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      verified: false,
      error: error?.message || "Unable to verify payment."
    });
  }
});

/**
 * Handles Razorpay webhook events with signature verification.
 * @param {express.Request} req
 * @param {express.Response} res
 * @returns {Promise<void>}
 */
async function razorpayWebhookHandler(req, res) {
  if (!isRazorpayConfigured()) {
    res.status(503).json({
      ok: false,
      error: "Razorpay is not configured on the server."
    });
    return;
  }

  const signature = toSafeString(req.headers["x-razorpay-signature"], 200);
  if (!signature) {
    res.status(400).json({
      ok: false,
      error: "Missing x-razorpay-signature header."
    });
    return;
  }

  const rawBody = Buffer.isBuffer(req.body)
    ? req.body
    : Buffer.from(String(req.body || ""), "utf8");

  const isValid = verifyWebhookSignature(rawBody, signature);
  if (!isValid) {
    res.status(401).json({
      ok: false,
      error: "Invalid webhook signature."
    });
    return;
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString("utf8"));
  } catch (error) {
    res.status(400).json({
      ok: false,
      error: "Invalid webhook payload JSON."
    });
    return;
  }

  const eventType = toSafeString(event?.event, 80);

  try {
    if (eventType === "payment.captured") {
      const payment = event?.payload?.payment?.entity || {};
      const amountInr = resolveAmountInr(null, payment.amount);
      if (amountInr) {
        await persistPaymentAndPlan({
          userId: pickUserId(payment?.notes),
          paymentId: toSafeString(payment.id, 120),
          status: toSafeString(payment.status || "captured", 40),
          amountInr,
          createdAt: payment.created_at
        });
      }
    } else if (eventType === "order.paid") {
      const order = event?.payload?.order?.entity || {};
      const payment = event?.payload?.payment?.entity || {};
      const amountInr = resolveAmountInr(null, payment.amount || order.amount_paid || order.amount);
      if (amountInr) {
        await persistPaymentAndPlan({
          userId: pickUserId(payment?.notes) || pickUserId(order?.notes),
          paymentId: toSafeString(payment.id || order.id, 120),
          status: toSafeString(payment.status || order.status || "paid", 40),
          amountInr,
          createdAt: payment.created_at || order.created_at
        });
      }
    }

    res.json({
      ok: true,
      received: true,
      event: eventType
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error?.message || "Failed to process webhook event."
    });
  }
}

/**
 * Returns integration state snapshot.
 * @returns {{razorpayConfigured:boolean,supabaseConfigured:boolean,razorpayKeyId:string,supportedAmountsInr:number[]}}
 */
function getIntegrationState() {
  return {
    razorpayConfigured: isRazorpayConfigured(),
    supabaseConfigured: isSupabaseConfigured(),
    razorpayKeyId: getPublicKeyId(),
    supportedAmountsInr: [...ALLOWED_AMOUNTS_INR]
  };
}

module.exports = {
  razorpayRouter: router,
  razorpayWebhookHandler,
  getIntegrationState,
  verifyPaymentsTableAccess
};
