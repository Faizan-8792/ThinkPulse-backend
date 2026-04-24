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
  createPaymentLink,
  fetchQrCode,
  fetchOrder,
  fetchPaymentLink,
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
const {
  creditWallet,
  getWalletSnapshot
} = require("../payments/wallet_store");
const {
  recordPendingTransaction,
  updateTransactionFromQrStatus,
  markTrackedTransactionPaid,
  getTrackedTransactionByQrId,
  getTrackedTransactionByRefs
} = require("../payments/transaction_store");

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
  let safeStatusCode = Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 600
    ? statusCode
    : null;

  if (!safeStatusCode) {
    const providerCode = String(error?.error?.code || error?.code || "").trim().toUpperCase();
    const providerMessage = String(error?.error?.description || error?.message || "").trim().toLowerCase();

    if (
      providerCode === "TOO_MANY_REQUESTS" ||
      providerCode === "RATE_LIMIT_ERROR" ||
      providerMessage.includes("too many requests") ||
      providerMessage.includes("rate limit")
    ) {
      safeStatusCode = 429;
    } else if (
      providerCode === "ETIMEDOUT" ||
      providerCode === "ESOCKETTIMEDOUT" ||
      providerMessage.includes("timeout") ||
      providerMessage.includes("timed out")
    ) {
      safeStatusCode = 504;
    } else if (
      providerCode === "ENOTFOUND" ||
      providerCode === "ECONNREFUSED" ||
      providerCode === "ECONNRESET" ||
      providerCode === "EAI_AGAIN" ||
      providerMessage.includes("network")
    ) {
      safeStatusCode = 503;
    }
  }

  return {
    statusCode: safeStatusCode,
    description: toSafeString(error?.error?.description || error?.message || "", 220),
    providerCode: toSafeString(error?.error?.code || "", 80),
    providerReason: toSafeString(error?.error?.reason || "", 120)
  };
}

/**
 * Returns true when provider error indicates QR endpoint is unavailable for account.
 * @param {any} error
 * @returns {boolean}
 */
function isQrApiUnavailableError(error) {
  const message = String(error?.error?.description || error?.message || "").trim().toLowerCase();
  const code = String(error?.error?.code || "").trim().toUpperCase();
  return code === "BAD_REQUEST_ERROR" && message.includes("requested url was not found");
}

/**
 * Builds normalized payment record id without duplicating known prefixes.
 * @param {string} prefix
 * @param {unknown} rawId
 * @returns {string}
 */
function buildPaymentRecordId(prefix, rawId) {
  const safePrefix = String(prefix || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 20);
  const safeRawId = toSafeString(rawId, 140);

  if (!safePrefix || !safeRawId) {
    return "";
  }

  if (safeRawId.startsWith(`${safePrefix}_`)) {
    return safeRawId;
  }

  return `${safePrefix}_${safeRawId}`;
}

/**
 * Returns true when id looks like a Razorpay payment id.
 * @param {unknown} value
 * @returns {boolean}
 */
function isRazorpayPaymentId(value) {
  return toSafeString(value, 140).startsWith("pay_");
}

/**
 * Prefers tracked transaction user id over notes when both are present and mismatch.
 * @param {unknown} notesUserId
 * @param {unknown} trackedUserId
 * @returns {{userId:string,source:string,mismatch:boolean}}
 */
function resolveTrustedUserId(notesUserId, trackedUserId) {
  const safeNotesUserId = toSafeString(notesUserId, 180);
  const safeTrackedUserId = toSafeString(trackedUserId, 180);

  if (
    safeTrackedUserId &&
    safeNotesUserId &&
    safeTrackedUserId.toLowerCase() !== safeNotesUserId.toLowerCase()
  ) {
    return {
      userId: safeTrackedUserId,
      source: "tracked",
      mismatch: true
    };
  }

  if (safeTrackedUserId) {
    return {
      userId: safeTrackedUserId,
      source: "tracked",
      mismatch: false
    };
  }

  return {
    userId: safeNotesUserId,
    source: safeNotesUserId ? "notes" : "none",
    mismatch: false
  };
}

/**
 * Marks response as non-cacheable for payment state endpoints.
 * @param {import("express").Response} res
 */
function setNoStoreHeaders(res) {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
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

router.get("/wallet/:userId", (req, res) => {
  const userId = toSafeString(req.params?.userId, 180).toLowerCase();
  if (!userId) {
    res.status(400).json({
      ok: false,
      error: "userId route param is required."
    });
    return;
  }

  const wallet = getWalletSnapshot(userId);
  res.json({
    ok: true,
    userId,
    balance: Number(wallet?.balance || 0),
    wallet: wallet || null
  });
});

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

  const description = toSafeString(
    req.body?.description ||
      (kind === "wallet_topup"
        ? `ThinkPulse wallet top-up Rs ${amountInr}`
        : `ThinkPulse ${amountInr === 100 ? "Premium" : "Basic"} plan Rs ${amountInr}`),
    180
  );

  try {
    let provider = "qr_code";
    let qr = null;

    try {
      qr = await createSingleUseQr({
        amountInr,
        userId,
        allowCustomAmount: kind === "wallet_topup",
        kind,
        description
      });
    } catch (error) {
      if (!isQrApiUnavailableError(error)) {
        throw error;
      }

      provider = "payment_link";
      qr = await createPaymentLink({
        amountInr,
        userId,
        allowCustomAmount: kind === "wallet_topup",
        kind,
        description
      });
    }

    const qrId = toSafeString(qr?.id, 140);
    const orderId = provider === "payment_link"
      ? ""
      : toSafeString(qr?.order_id || qr?.orderId, 140);
    const imageUrl = provider === "payment_link"
      ? ""
      : toSafeString(qr?.image_url || qr?.imageUrl, 2000);
    const upiIntent = provider === "payment_link"
      ? toSafeString(qr?.short_url || qr?.shortUrl, 2000)
      : toSafeString(qr?.image_content || qr?.payment_url || qr?.upiIntent || qr?.upi_intent, 2000);
    if (provider === "qr_code" && imageUrl && !upiIntent) {
      console.warn("[RazorpayQR] QR created without image_content. Plain QR rendering will not be possible.", {
        qrId,
        provider,
        amountInr
      });
    }
    const amountPaise = provider === "payment_link"
      ? Math.max(0, Number(qr?.amount || Math.round(amountInr * 100)))
      : Math.max(0, Number(qr?.payment_amount || qr?.amount || Math.round(amountInr * 100)));
    const safeAmountInr = Number(fromPaise(amountPaise)) || amountInr;
    const closeBy = provider === "payment_link"
      ? Math.max(0, Number(qr?.expire_by) || 0)
      : Math.max(0, Number(qr?.close_by || qr?.closeBy) || 0);
    const createdAtSec = Math.max(0, Number(qr?.created_at || qr?.createdAt) || 0);
    const amountReceivedPaise = provider === "payment_link"
      ? Math.max(0, Number(qr?.amount_paid) || 0)
      : Math.max(0, Number(qr?.payments_amount_received) || 0);
    const paymentsCountReceived = provider === "payment_link"
      ? (Array.isArray(qr?.payments) ? qr.payments.length : (amountReceivedPaise > 0 ? 1 : 0))
      : Math.max(0, Number(qr?.payments_count_received) || 0);

    const transaction = qrId
      ? recordPendingTransaction({
          qrId,
          orderId,
          userId,
          amountInr: safeAmountInr,
          kind,
          closeByMs: closeBy > 0 ? closeBy * 1000 : 0,
          providerStatus: String(qr?.status || "created").toLowerCase(),
          providerEvent: provider === "payment_link" ? "create_payment_link" : "create_qr",
          createdAt: createdAtSec > 0 ? createdAtSec * 1000 : Date.now()
        })
      : null;

    const pendingPaymentId = qrId
      ? buildPaymentRecordId(provider === "payment_link" ? "plink" : "qr", qrId)
      : "";

    let pendingPersistence = null;
    if (pendingPaymentId && safeAmountInr > 0) {
      try {
        pendingPersistence = await upsertPaymentRecord({
          userId,
          paymentId: pendingPaymentId,
          status: "pending",
          amountInr: safeAmountInr,
          createdAt: createdAtSec > 0 ? createdAtSec : Date.now()
        });
      } catch (error) {
        pendingPersistence = {
          stored: false,
          reason: error?.message || "Unable to persist pending payment state."
        };
      }
    }

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
        kind,
        provider
      },
      transaction,
      persistence: pendingPersistence
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

router.get("/transaction-status/:qrId", (req, res) => {
  setNoStoreHeaders(res);

  const qrId = toSafeString(req.params?.qrId, 140);
  if (!qrId) {
    res.status(400).json({
      ok: false,
      error: "qrId route param is required."
    });
    return;
  }

  const transactionByQrId = getTrackedTransactionByQrId(qrId);
  const fallbackResolved = transactionByQrId
    ? {
        transaction: transactionByQrId,
        matchedBy: "qrId"
      }
    : getTrackedTransactionByRefs({
        qrId,
        orderId: qrId,
        paymentId: qrId
      });

  const transaction = transactionByQrId || fallbackResolved.transaction;

  res.json({
    ok: true,
    found: Boolean(transaction),
    matchedBy: fallbackResolved.matchedBy,
    transaction
  });
});

router.get("/qr-status/:qrId", async (req, res) => {
  setNoStoreHeaders(res);

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
    const isPaymentLinkReference = qrId.startsWith("plink_");

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
      const orderPaymentId = buildPaymentRecordId("order", qrId);
      if (paid && amountInr) {
        persistence = await persistPaymentAndPlan({
          userId: orderUserId || requesterUserId,
          paymentId: orderPaymentId,
          status: "captured",
          amountInr,
          createdAt: order?.created_at
        });
      }

      const trackedByOrder = getTrackedTransactionByRefs({ orderId: qrId });
      const resolvedTrackedQrId = toSafeString(trackedByOrder.transaction?.qrId, 140) || qrId;

      const transaction = updateTransactionFromQrStatus({
        qrId: resolvedTrackedQrId,
        orderId: qrId,
        paymentId: paid ? orderPaymentId : "",
        userId: orderUserId || requesterUserId,
        amountInr: amountInr || 0,
        kind,
        closeByMs: 0,
        providerStatus: paid ? "paid" : orderStatus,
        providerEvent: "qr_status_order",
        paid,
        createdAt: order?.created_at
      });

      const trackedQrPaymentId = buildPaymentRecordId("qr", transaction?.qrId);
      if (paid && trackedQrPaymentId && amountInr > 0) {
        await upsertPaymentRecord({
          userId: orderUserId || requesterUserId,
          paymentId: trackedQrPaymentId,
          status: "captured",
          amountInr,
          createdAt: order?.created_at
        }).catch(() => undefined);
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
            id: orderPaymentId,
            status: "captured",
            amountInr: amountInr || null,
            userId: orderUserId || requesterUserId || "",
            kind
          }
          : null,
        persistence,
        transaction
      });
      return;
    }

    if (isPaymentLinkReference) {
      const paymentLink = await fetchPaymentLink(qrId);
      const paymentLinkUserId = pickUserId(paymentLink?.notes);

      if (
        requesterUserId &&
        paymentLinkUserId &&
        requesterUserId.toLowerCase() !== paymentLinkUserId.toLowerCase()
      ) {
        res.status(403).json({
          ok: false,
          error: "Payment link does not belong to requested user."
        });
        return;
      }

      const paymentLinkStatus = toSafeString(paymentLink?.status, 40).toLowerCase() || "created";
      const kind = toSafeString(paymentLink?.notes?.kind, 40).toLowerCase() || "plan_purchase";
      const amountPaise = Math.max(0, Number(paymentLink?.amount) || 0);
      const amountReceivedPaise = Math.max(0, Number(paymentLink?.amount_paid) || 0);
      const paymentsCountReceived = Array.isArray(paymentLink?.payments)
        ? paymentLink.payments.length
        : (amountReceivedPaise > 0 ? 1 : 0);
      const amountInr = resolveAmountInr(null, amountPaise);
      const paid = Boolean(
        paymentLinkStatus === "paid" &&
          amountPaise > 0 &&
          amountReceivedPaise >= amountPaise
      );

      let persistence = null;
      const paymentLinkPaymentId = buildPaymentRecordId("plink", qrId);
      if (paid && amountInr) {
        persistence = await persistPaymentAndPlan({
          userId: paymentLinkUserId || requesterUserId,
          paymentId: paymentLinkPaymentId,
          status: "captured",
          amountInr,
          createdAt: paymentLink?.paid_at || paymentLink?.updated_at || paymentLink?.created_at
        });
      }

      const transaction = updateTransactionFromQrStatus({
        qrId,
        orderId: "",
        paymentId: paid ? paymentLinkPaymentId : "",
        userId: paymentLinkUserId || requesterUserId,
        amountInr: amountInr || 0,
        kind,
        closeByMs: Number(paymentLink?.expire_by || 0) > 0 ? Number(paymentLink.expire_by) * 1000 : 0,
        providerStatus: paymentLinkStatus,
        providerEvent: "payment_link_status",
        paid,
        createdAt: paymentLink?.created_at,
        paidAt: paymentLink?.paid_at || paymentLink?.updated_at
      });

      res.json({
        ok: true,
        paid,
        qr: {
          id: qrId,
          status: paymentLinkStatus,
          closeBy: Number(paymentLink?.expire_by) || 0,
          closedAt: Number(paymentLink?.paid_at || paymentLink?.expired_at || 0) || 0,
          closeReason: "",
          amountPaise,
          amountInr: amountInr || null,
          amountReceivedPaise,
          paymentsCountReceived,
          userId: paymentLinkUserId || "",
          kind
        },
        payment: paid
          ? {
            id: paymentLinkPaymentId,
            status: "captured",
            amountInr: amountInr || null,
            userId: paymentLinkUserId || requesterUserId || "",
            kind
          }
          : null,
        persistence,
        transaction
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
    const qrPaymentId = buildPaymentRecordId("qr", qrId);
    if (paid && amountInr) {
      persistence = await persistPaymentAndPlan({
        userId: qrUserId || requesterUserId,
        paymentId: qrPaymentId,
        status: "captured",
        amountInr,
        createdAt: qr?.closed_at || qr?.created_at
      });
    }

    const transaction = updateTransactionFromQrStatus({
      qrId,
      orderId: toSafeString(qr?.order_id || qr?.orderId, 140),
      paymentId: paid ? qrPaymentId : "",
      userId: qrUserId || requesterUserId,
      amountInr: amountInr || 0,
      kind,
      closeByMs: Number(qr?.close_by || 0) > 0 ? Number(qr.close_by) * 1000 : 0,
      providerStatus: qrStatus,
      providerEvent: "qr_status",
      paid,
      createdAt: qr?.created_at,
      paidAt: qr?.closed_at
    });

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
          id: qrPaymentId,
          status: "captured",
          amountInr: amountInr || null,
          userId: qrUserId || requesterUserId || "",
          kind
        }
        : null,
      persistence,
      transaction
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
        error:
          `amount must be one of: ${ALLOWED_AMOUNTS_INR.join(", ")} ` +
          `or wallet top-up amount between ${MIN_WALLET_TOPUP_INR} and ${MAX_WALLET_TOPUP_INR}`
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
    const kind = String(req.body?.kind || paymentDetails?.notes?.kind || "").trim().toLowerCase() === "wallet_topup"
      ? "wallet_topup"
      : "plan_purchase";
    const persistence = await persistPaymentAndPlan({
      userId,
      paymentId,
      status,
      amountInr,
      createdAt: paymentDetails?.created_at
    });

    const tracked = markTrackedTransactionPaid({
      orderId,
      paymentId,
      userId,
      amountInr,
      kind,
      providerStatus: status,
      providerEvent: "verify_payment",
      createdAt: paymentDetails?.created_at,
      paidAt: paymentDetails?.created_at
    });

    if (tracked.transaction?.qrId && amountInr > 0) {
      await upsertPaymentRecord({
        userId: tracked.transaction.userId || userId,
        paymentId: `qr_${tracked.transaction.qrId}`,
        status,
        amountInr,
        createdAt: paymentDetails?.created_at
      }).catch(() => undefined);
    }

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
      persistence,
      transaction: tracked.transaction,
      transactionMatchedBy: tracked.matchedBy
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

  const webhookPath = toSafeString(req.originalUrl || req.path || "/webhooks", 140) || "/webhooks";

  const signature = toSafeString(req.headers["x-razorpay-signature"], 200);
  if (!signature) {
    console.warn(`[razorpay-webhook] signature path=${webhookPath} valid=false reason=missing_header`);
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
  console.info(`[razorpay-webhook] signature path=${webhookPath} valid=${isValid ? "true" : "false"}`);
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
  console.info(`[razorpay-webhook] event_received type=${eventType || "unknown"}`);

  try {
    let transaction = null;
    let transactionMatchedBy = "none";
    let persistence = null;
    let wallet = null;

    if (eventType === "payment.captured") {
      const payment = event?.payload?.payment?.entity || {};
      const paymentId = toSafeString(payment.id, 120);
      const orderId = toSafeString(payment.order_id, 120);
      const status = toSafeString(payment.status || "captured", 40);
      const kind = String(payment?.notes?.kind || "").trim().toLowerCase() === "wallet_topup"
        ? "wallet_topup"
        : "plan_purchase";
      const amountInr = resolveAmountInr(null, payment.amount);
      const notesUserId = pickUserId(payment?.notes);
      const trackedCandidate = getTrackedTransactionByRefs({
        orderId,
        paymentId,
        userId: notesUserId,
        amountInr: amountInr || 0
      });
      const trustedUser = resolveTrustedUserId(
        notesUserId,
        trackedCandidate.transaction?.userId
      );
      const userId = trustedUser.userId;
      const paymentRecordId = isRazorpayPaymentId(paymentId)
        ? paymentId
        : buildPaymentRecordId("order", orderId);

      if (trustedUser.mismatch) {
        console.warn(
          `[razorpay-webhook] event=payment.captured user_mismatch=true notesUser=${toSafeString(notesUserId, 180).toLowerCase() || "na"} trackedUser=${toSafeString(trackedCandidate.transaction?.userId, 180).toLowerCase() || "na"}`
        );
      }

      if (amountInr && paymentRecordId) {
        persistence = await persistPaymentAndPlan({
          userId,
          paymentId: paymentRecordId,
          status,
          amountInr,
          createdAt: payment.created_at
        });
      }

      const walletUserId = toSafeString(userId, 180).toLowerCase();
      const walletPaymentId = isRazorpayPaymentId(paymentId) ? paymentId : "";
      if (walletUserId && amountInr && walletPaymentId) {
        wallet = await creditWallet({
          userId: walletUserId,
          amountInr,
          paymentId: walletPaymentId,
          orderId,
          source: "payment.captured"
        });
      } else {
        wallet = {
          applied: false,
          reason: !walletUserId
            ? "missing_user_id"
            : !amountInr
              ? "invalid_amount"
              : "missing_payment_id"
        };
      }

      const tracked = markTrackedTransactionPaid({
        orderId,
        paymentId: paymentRecordId || paymentId,
        userId,
        amountInr: amountInr || 0,
        kind,
        providerStatus: status,
        providerEvent: "payment.captured",
        createdAt: payment.created_at,
        paidAt: payment.created_at
      });
      transaction = tracked.transaction;
      transactionMatchedBy = tracked.matchedBy;

      const trackedQrPaymentId = buildPaymentRecordId("qr", transaction?.qrId);
      if (trackedQrPaymentId && amountInr) {
        await upsertPaymentRecord({
          userId: transaction.userId || userId,
          paymentId: trackedQrPaymentId,
          status,
          amountInr,
          createdAt: payment.created_at
        }).catch(() => undefined);
      }

      console.info(
        `[razorpay-webhook] event=payment.captured paymentId=${paymentId || "na"} orderId=${orderId || "na"} userId=${walletUserId || "na"} amountInr=${amountInr || 0} walletApplied=${wallet?.applied === true}`
      );
    } else if (eventType === "order.paid") {
      const order = event?.payload?.order?.entity || {};
      const payment = event?.payload?.payment?.entity || {};
      const paymentEntityId = toSafeString(payment.id, 120);
      const orderId = toSafeString(order.id || payment.order_id, 120);
      const paymentId = paymentEntityId || buildPaymentRecordId("order", orderId);
      const status = toSafeString(payment.status || order.status || "paid", 40);
      const kind = String(payment?.notes?.kind || order?.notes?.kind || "").trim().toLowerCase() === "wallet_topup"
        ? "wallet_topup"
        : "plan_purchase";
      const amountInr = resolveAmountInr(null, payment.amount || order.amount_paid || order.amount);
      const notesUserId = pickUserId(payment?.notes) || pickUserId(order?.notes);
      const trackedCandidate = getTrackedTransactionByRefs({
        orderId,
        paymentId,
        userId: notesUserId,
        amountInr: amountInr || 0
      });
      const trustedUser = resolveTrustedUserId(
        notesUserId,
        trackedCandidate.transaction?.userId
      );
      const userId = trustedUser.userId;

      if (trustedUser.mismatch) {
        console.warn(
          `[razorpay-webhook] event=order.paid user_mismatch=true notesUser=${toSafeString(notesUserId, 180).toLowerCase() || "na"} trackedUser=${toSafeString(trackedCandidate.transaction?.userId, 180).toLowerCase() || "na"}`
        );
      }

      if (amountInr && paymentId) {
        persistence = await persistPaymentAndPlan({
          userId,
          paymentId,
          status,
          amountInr,
          createdAt: payment.created_at || order.created_at
        });
      }

      const walletUserId = toSafeString(userId, 180).toLowerCase();
      const walletPaymentId = isRazorpayPaymentId(paymentEntityId) ? paymentEntityId : "";
      if (walletUserId && amountInr && walletPaymentId) {
        wallet = await creditWallet({
          userId: walletUserId,
          amountInr,
          paymentId: walletPaymentId,
          orderId,
          source: "order.paid"
        });
      } else {
        wallet = {
          applied: false,
          reason: !walletUserId
            ? "missing_user_id"
            : !amountInr
              ? "invalid_amount"
              : "missing_payment_id"
        };
      }

      const tracked = markTrackedTransactionPaid({
        orderId,
        paymentId,
        userId,
        amountInr: amountInr || 0,
        kind,
        providerStatus: status,
        providerEvent: "order.paid",
        createdAt: payment.created_at || order.created_at,
        paidAt: payment.created_at || order.paid_at || order.created_at
      });
      transaction = tracked.transaction;
      transactionMatchedBy = tracked.matchedBy;

      const trackedQrPaymentId = buildPaymentRecordId("qr", transaction?.qrId);
      if (trackedQrPaymentId && amountInr) {
        await upsertPaymentRecord({
          userId: transaction.userId || userId,
          paymentId: trackedQrPaymentId,
          status,
          amountInr,
          createdAt: payment.created_at || order.created_at
        }).catch(() => undefined);
      }

      console.info(
        `[razorpay-webhook] event=order.paid paymentId=${paymentId || "na"} orderId=${orderId || "na"} userId=${walletUserId || "na"} amountInr=${amountInr || 0} walletApplied=${wallet?.applied === true}`
      );
    } else if (eventType === "payment.failed") {
      const payment = event?.payload?.payment?.entity || {};
      const paymentId = toSafeString(payment.id, 120);
      const orderId = toSafeString(payment.order_id, 120);
      const userId = pickUserId(payment?.notes);
      const kind = String(payment?.notes?.kind || "").trim().toLowerCase() === "wallet_topup"
        ? "wallet_topup"
        : "plan_purchase";
      const amountInr = resolveAmountInr(null, payment.amount);
      const failureCode = toSafeString(
        payment?.error_code || payment?.error_reason || payment?.error_description,
        180
      ) || "unknown";

      wallet = {
        applied: false,
        reason: "payment_failed"
      };

      const tracked = getTrackedTransactionByRefs({
        orderId,
        paymentId,
        userId,
        amountInr: amountInr || 0
      });
      transactionMatchedBy = tracked.matchedBy;

      if (tracked.transaction?.qrId) {
        transaction = updateTransactionFromQrStatus({
          qrId: tracked.transaction.qrId,
          orderId,
          paymentId,
          userId,
          amountInr: amountInr || 0,
          kind,
          providerStatus: "failed",
          providerEvent: "payment.failed",
          failureReason: failureCode,
          paid: false,
          createdAt: payment.created_at
        });
      }

      console.warn(
        `[razorpay-webhook] event=payment.failed paymentId=${paymentId || "na"} orderId=${orderId || "na"} userId=${toSafeString(userId, 180).toLowerCase() || "na"} amountInr=${amountInr || 0} reason=${failureCode}`
      );
    } else {
      wallet = {
        applied: false,
        reason: "ignored_event"
      };
      console.info(`[razorpay-webhook] event=${eventType || "unknown"} ignored=true`);
    }

    res.json({
      ok: true,
      received: true,
      event: eventType,
      persistence,
      wallet,
      transaction,
      transactionMatchedBy
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
