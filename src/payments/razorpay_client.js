"use strict";

const crypto = require("crypto");
const Razorpay = require("razorpay");

const {
  normalizeAmountInr,
  resolvePlanByAmount,
  toPaise
} = require("./amounts");

const razorpayKeyId = String(process.env.RAZORPAY_KEY_ID || "").trim();
const razorpayKeySecret = String(process.env.RAZORPAY_KEY_SECRET || "").trim();
const razorpayWebhookSecret = String(process.env.RAZORPAY_WEBHOOK_SECRET || "").trim();

const razorpayClient = razorpayKeyId && razorpayKeySecret
  ? new Razorpay({
      key_id: razorpayKeyId,
      key_secret: razorpayKeySecret
    })
  : null;

if (!razorpayClient) {
  console.warn("[razorpay] Missing RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET. Razorpay APIs are disabled.");
}

/**
 * Returns true when Razorpay credentials are configured.
 * @returns {boolean}
 */
function isConfigured() {
  return Boolean(razorpayClient);
}

/**
 * Returns public Razorpay key id.
 * @returns {string}
 */
function getPublicKeyId() {
  return razorpayKeyId;
}

/**
 * Throws when Razorpay is not configured.
 */
function assertConfigured() {
  if (!razorpayClient) {
    throw new Error("Razorpay is not configured.");
  }
}

/**
 * Returns string-safe value for notes map.
 * @param {unknown} value
 * @returns {string}
 */
function toSafeNote(value) {
  return String(value || "").trim().slice(0, 256);
}

/**
 * Sanitizes Razorpay notes payload.
 * @param {Record<string, unknown>|null|undefined} value
 * @returns {Record<string, string>}
 */
function sanitizeNotes(value) {
  const source = value && typeof value === "object" ? value : {};
  const out = {};
  const entries = Object.entries(source).slice(0, 10);
  for (const [rawKey, rawValue] of entries) {
    const key = toSafeNote(rawKey);
    const note = toSafeNote(rawValue);
    if (!key || !note) {
      continue;
    }
    out[key] = note;
  }
  return out;
}

/**
 * Builds a short Razorpay receipt string.
 * @param {string} prefix
 * @returns {string}
 */
function buildReceipt(prefix) {
  const safePrefix = String(prefix || "tp").replace(/[^a-z0-9_-]/gi, "").toLowerCase() || "tp";
  const stamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${safePrefix}_${stamp}_${random}`.slice(0, 40);
}

/**
 * Performs a constant-time comparison for strings.
 * @param {string} left
 * @param {string} right
 * @returns {boolean}
 */
function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""), "utf8");
  const rightBuffer = Buffer.from(String(right || ""), "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

/**
 * Creates Razorpay order for supported INR amounts.
 * @param {{amountInr:number,userId:string,notes?:Record<string,unknown>}} payload
 * @returns {Promise<any>}
 */
async function createOrder(payload) {
  assertConfigured();

  const amountInr = normalizeAmountInr(payload?.amountInr);
  if (!amountInr) {
    throw new Error("Amount must be 10 or 20 INR.");
  }

  const userId = toSafeNote(payload?.userId);
  if (!userId) {
    throw new Error("userId is required.");
  }

  const plan = resolvePlanByAmount(amountInr) || "basic";

  return razorpayClient.orders.create({
    amount: toPaise(amountInr),
    currency: "INR",
    receipt: buildReceipt("ord"),
    notes: {
      userId,
      plan,
      source: "thinkpulse-extension",
      ...sanitizeNotes(payload?.notes)
    }
  });
}

/**
 * Creates a dynamic single-use UPI QR for fixed amount.
 * @param {{amountInr:number,userId:string,description?:string}} payload
 * @returns {Promise<any>}
 */
async function createSingleUseQr(payload) {
  assertConfigured();

  const amountInr = normalizeAmountInr(payload?.amountInr);
  if (!amountInr) {
    throw new Error("Amount must be 10 or 20 INR.");
  }

  const userId = toSafeNote(payload?.userId);
  if (!userId) {
    throw new Error("userId is required.");
  }

  const plan = resolvePlanByAmount(amountInr) || "basic";
  const closeBy = Math.floor(Date.now() / 1000) + (15 * 60);

  return razorpayClient.qrCode.create({
    type: "upi_qr",
    name: "ThinkPulse",
    usage: "single_use",
    fixed_amount: true,
    payment_amount: toPaise(amountInr),
    description: toSafeNote(payload?.description) || `ThinkPulse ${plan} payment`,
    close_by: closeBy,
    notes: {
      userId,
      plan,
      source: "thinkpulse-extension"
    }
  });
}

/**
 * Fetches Razorpay QR details by id.
 * @param {string} qrId
 * @returns {Promise<any>}
 */
async function fetchQrCode(qrId) {
  assertConfigured();
  const safeQrId = toSafeNote(qrId);
  if (!safeQrId) {
    throw new Error("qrId is required.");
  }
  return razorpayClient.qrCode.fetch(safeQrId);
}

/**
 * Fetches Razorpay payment details.
 * @param {string} paymentId
 * @returns {Promise<any>}
 */
async function fetchPayment(paymentId) {
  assertConfigured();
  const safePaymentId = toSafeNote(paymentId);
  if (!safePaymentId) {
    throw new Error("paymentId is required.");
  }
  return razorpayClient.payments.fetch(safePaymentId);
}

/**
 * Verifies Razorpay payment signature for order + payment IDs.
 * @param {{orderId:string,paymentId:string,signature:string}} payload
 * @returns {boolean}
 */
function verifyPaymentSignature(payload) {
  if (!razorpayKeySecret) {
    return false;
  }

  const orderId = toSafeNote(payload?.orderId);
  const paymentId = toSafeNote(payload?.paymentId);
  const signature = toSafeNote(payload?.signature);

  if (!orderId || !paymentId || !signature) {
    return false;
  }

  const content = `${orderId}|${paymentId}`;
  const expected = crypto
    .createHmac("sha256", razorpayKeySecret)
    .update(content)
    .digest("hex");

  return safeEqual(expected, signature);
}

/**
 * Verifies Razorpay webhook signature from raw request body.
 * @param {Buffer|string} rawBody
 * @param {string} signature
 * @returns {boolean}
 */
function verifyWebhookSignature(rawBody, signature) {
  if (!razorpayWebhookSecret) {
    return false;
  }

  const safeSignature = toSafeNote(signature);
  if (!safeSignature) {
    return false;
  }

  const source = Buffer.isBuffer(rawBody)
    ? rawBody
    : Buffer.from(String(rawBody || ""), "utf8");

  const expected = crypto
    .createHmac("sha256", razorpayWebhookSecret)
    .update(source)
    .digest("hex");

  return safeEqual(expected, safeSignature);
}

module.exports = {
  isConfigured,
  getPublicKeyId,
  createOrder,
  createSingleUseQr,
  fetchQrCode,
  fetchPayment,
  verifyPaymentSignature,
  verifyWebhookSignature
};
