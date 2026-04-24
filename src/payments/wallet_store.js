"use strict";

const fs = require("fs");
const path = require("path");
const { resolveStorePath } = require("../storage/store_path");

const MAX_PROCESSED_PAYMENTS = 20000;
const walletStorePath = resolveStorePath(process.env.WALLET_STORE_PATH, "wallets.json");

let store = {
  wallets: {},
  processedPayments: {},
  updatedAt: Date.now()
};

let initialized = false;
let persistQueue = Promise.resolve();

/**
 * Converts unknown value to safe short string.
 * @param {unknown} value
 * @param {number=} maxLength
 * @returns {string}
 */
function toSafeString(value, maxLength = 180) {
  return String(value || "").trim().slice(0, maxLength);
}

/**
 * Normalizes user id for wallet indexing.
 * @param {unknown} value
 * @returns {string}
 */
function normalizeUserId(value) {
  return toSafeString(value, 180).toLowerCase();
}

/**
 * Normalizes payment id for idempotency keys.
 * @param {unknown} value
 * @returns {string}
 */
function normalizePaymentId(value) {
  return toSafeString(value, 140);
}

/**
 * Returns rounded positive INR amount.
 * @param {unknown} value
 * @returns {number}
 */
function normalizeAmountInr(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }
  return Math.round(numeric * 100) / 100;
}

/**
 * Normalizes timestamp-like values to epoch milliseconds.
 * @param {unknown} value
 * @returns {number}
 */
function toEpochMs(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric > 1_000_000_000_000 ? Math.round(numeric) : Math.round(numeric * 1000);
  }

  const parsed = new Date(String(value || ""));
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.getTime();
  }

  return 0;
}

/**
 * Returns normalized wallet entry.
 * @param {string} userId
 * @param {any} value
 * @returns {{userId:string,balance:number,creditsCount:number,lastCreditAmount:number,lastPaymentId:string,lastSource:string,updatedAt:number}}
 */
function normalizeWalletEntry(userId, value) {
  const safeUserId = normalizeUserId(userId);
  return {
    userId: safeUserId,
    balance: Math.max(0, normalizeAmountInr(value?.balance)),
    creditsCount: Math.max(0, Math.round(Number(value?.creditsCount) || 0)),
    lastCreditAmount: Math.max(0, normalizeAmountInr(value?.lastCreditAmount)),
    lastPaymentId: normalizePaymentId(value?.lastPaymentId),
    lastSource: toSafeString(value?.lastSource, 80),
    updatedAt: toEpochMs(value?.updatedAt) || Date.now()
  };
}

/**
 * Returns normalized payment idempotency record.
 * @param {string} paymentId
 * @param {any} value
 * @returns {{userId:string,amountInr:number,source:string,orderId:string,creditedAt:number}|null}
 */
function normalizeProcessedPayment(paymentId, value) {
  const safePaymentId = normalizePaymentId(paymentId);
  if (!safePaymentId) {
    return null;
  }

  const userId = normalizeUserId(value?.userId);
  if (!userId) {
    return null;
  }

  const amountInr = normalizeAmountInr(value?.amountInr);
  if (amountInr <= 0) {
    return null;
  }

  return {
    userId,
    amountInr,
    source: toSafeString(value?.source, 80) || "payment.captured",
    orderId: toSafeString(value?.orderId, 140),
    creditedAt: toEpochMs(value?.creditedAt) || Date.now()
  };
}

/**
 * Trims processed payment map by most recent credited timestamp.
 * @param {Record<string, any>} map
 * @returns {Record<string, any>}
 */
function trimProcessedPayments(map) {
  const entries = Object.entries(map || {});
  if (entries.length <= MAX_PROCESSED_PAYMENTS) {
    return map;
  }

  entries.sort((left, right) => {
    const leftTs = Number(left?.[1]?.creditedAt || 0);
    const rightTs = Number(right?.[1]?.creditedAt || 0);
    return rightTs - leftTs;
  });

  return Object.fromEntries(entries.slice(0, MAX_PROCESSED_PAYMENTS));
}

/**
 * Normalizes wallet store payload loaded from disk.
 * @param {any} raw
 * @returns {{wallets:Record<string, any>,processedPayments:Record<string, any>,updatedAt:number}}
 */
function normalizeStore(raw) {
  const wallets = {};
  const sourceWallets = raw?.wallets && typeof raw.wallets === "object" ? raw.wallets : {};

  for (const [userId, value] of Object.entries(sourceWallets)) {
    const safeUserId = normalizeUserId(userId);
    if (!safeUserId) {
      continue;
    }
    wallets[safeUserId] = normalizeWalletEntry(safeUserId, value);
  }

  const processedPayments = {};
  const sourceProcessed =
    raw?.processedPayments && typeof raw.processedPayments === "object"
      ? raw.processedPayments
      : {};

  for (const [paymentId, value] of Object.entries(sourceProcessed)) {
    const safePaymentId = normalizePaymentId(paymentId);
    const normalized = normalizeProcessedPayment(safePaymentId, value);
    if (!safePaymentId || !normalized) {
      continue;
    }
    processedPayments[safePaymentId] = normalized;
  }

  return {
    wallets,
    processedPayments: trimProcessedPayments(processedPayments),
    updatedAt: toEpochMs(raw?.updatedAt) || Date.now()
  };
}

/**
 * Loads wallet state from disk once per process boot.
 */
function ensureLoaded() {
  if (initialized) {
    return;
  }

  initialized = true;
  try {
    if (!fs.existsSync(walletStorePath)) {
      return;
    }

    const content = fs.readFileSync(walletStorePath, "utf8");
    if (!content.trim()) {
      return;
    }

    const parsed = JSON.parse(content);
    store = normalizeStore(parsed);
  } catch (error) {
    console.warn("[wallet-store] Failed to load wallet store:", error?.message || error);
    store = {
      wallets: {},
      processedPayments: {},
      updatedAt: Date.now()
    };
  }
}

/**
 * Persists current in-memory state to disk.
 * @returns {Promise<void>}
 */
function persistStore() {
  const snapshot = JSON.stringify(store, null, 2);
  persistQueue = persistQueue
    .catch(() => undefined)
    .then(async () => {
      await fs.promises.mkdir(path.dirname(walletStorePath), { recursive: true });
      await fs.promises.writeFile(walletStorePath, snapshot, "utf8");
    })
    .catch((error) => {
      console.error("[wallet-store] Failed to persist wallet store:", error?.message || error);
      throw error;
    });

  return persistQueue;
}

/**
 * Returns wallet snapshot for one user.
 * @param {string} userId
 * @returns {{userId:string,balance:number,updatedAt:number,creditsCount:number,lastCreditAmount:number,lastPaymentId:string,lastSource:string}|null}
 */
function getWalletSnapshot(userId) {
  ensureLoaded();

  const safeUserId = normalizeUserId(userId);
  if (!safeUserId) {
    return null;
  }

  const current = store.wallets[safeUserId]
    ? normalizeWalletEntry(safeUserId, store.wallets[safeUserId])
    : normalizeWalletEntry(safeUserId, {
        balance: 0,
        creditsCount: 0,
        lastCreditAmount: 0,
        lastPaymentId: "",
        lastSource: "",
        updatedAt: 0
      });

  return {
    userId: current.userId,
    balance: current.balance,
    updatedAt: current.updatedAt,
    creditsCount: current.creditsCount,
    lastCreditAmount: current.lastCreditAmount,
    lastPaymentId: current.lastPaymentId,
    lastSource: current.lastSource
  };
}

/**
 * Credits wallet balance for a successful payment.
 * Idempotent by payment id.
 * @param {{userId:string,amountInr:number,paymentId:string,orderId?:string,source?:string}} payload
 * @returns {Promise<{applied:boolean,reason:string,paymentId?:string,creditedAmountInr?:number,wallet:any}>}
 */
async function creditWallet(payload) {
  ensureLoaded();

  const userId = normalizeUserId(payload?.userId);
  const amountInr = normalizeAmountInr(payload?.amountInr);
  const paymentId = normalizePaymentId(payload?.paymentId);
  const orderId = toSafeString(payload?.orderId, 140);
  const source = toSafeString(payload?.source, 80) || "payment.captured";

  if (!userId) {
    return {
      applied: false,
      reason: "missing_user_id",
      wallet: null
    };
  }

  if (amountInr <= 0) {
    return {
      applied: false,
      reason: "invalid_amount",
      wallet: getWalletSnapshot(userId)
    };
  }

  if (!paymentId) {
    return {
      applied: false,
      reason: "missing_payment_id",
      wallet: getWalletSnapshot(userId)
    };
  }

  if (store.processedPayments[paymentId]) {
    return {
      applied: false,
      reason: "duplicate_payment",
      paymentId,
      wallet: getWalletSnapshot(userId)
    };
  }

  const existing = normalizeWalletEntry(userId, store.wallets[userId]);
  const now = Date.now();
  const nextBalance = normalizeAmountInr(existing.balance + amountInr);

  store.wallets[userId] = normalizeWalletEntry(userId, {
    ...existing,
    balance: nextBalance,
    creditsCount: existing.creditsCount + 1,
    lastCreditAmount: amountInr,
    lastPaymentId: paymentId,
    lastSource: source,
    updatedAt: now
  });

  store.processedPayments[paymentId] = {
    userId,
    amountInr,
    source,
    orderId,
    creditedAt: now
  };
  store.processedPayments = trimProcessedPayments(store.processedPayments);
  store.updatedAt = now;

  await persistStore();

  return {
    applied: true,
    reason: "credited",
    paymentId,
    creditedAmountInr: amountInr,
    wallet: getWalletSnapshot(userId)
  };
}

module.exports = {
  creditWallet,
  getWalletSnapshot
};
