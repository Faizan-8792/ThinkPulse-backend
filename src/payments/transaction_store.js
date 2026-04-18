"use strict";

const TRANSACTION_TTL_MS = 72 * 60 * 60 * 1000;
const PENDING_MATCH_WINDOW_MS = 90 * 60 * 1000;

const transactionsByQrId = new Map();
const qrIdByOrderId = new Map();
const qrIdByPaymentId = new Map();

/**
 * Converts unknown value to safe string.
 * @param {unknown} value
 * @param {number=} maxLength
 * @returns {string}
 */
function toSafeString(value, maxLength = 180) {
  return String(value || "").trim().slice(0, maxLength);
}

/**
 * Converts unknown to safe rounded amount.
 * @param {unknown} value
 * @returns {number}
 */
function toSafeAmountInr(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }
  return Math.round(numeric * 100) / 100;
}

/**
 * Normalizes timestamp-like value to epoch milliseconds.
 * @param {unknown} value
 * @returns {number}
 */
function toEpochMs(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric > 1_000_000_000_000 ? Math.round(numeric) : Math.round(numeric * 1000);
  }

  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.getTime();
  }

  const parsed = new Date(String(value || ""));
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.getTime();
  }

  return 0;
}

/**
 * Normalizes known transaction states.
 * @param {unknown} value
 * @returns {"pending"|"paid"|"closed"|"expired"|"failed"|"cancelled"}
 */
function normalizeStatus(value) {
  const safe = String(value || "").trim().toLowerCase();
  if (!safe) {
    return "pending";
  }

  if (["paid", "captured", "success", "successful"].includes(safe)) {
    return "paid";
  }
  if (["closed"].includes(safe)) {
    return "closed";
  }
  if (["expired", "expire"].includes(safe)) {
    return "expired";
  }
  if (["failed", "failure", "error"].includes(safe)) {
    return "failed";
  }
  if (["cancelled", "canceled"].includes(safe)) {
    return "cancelled";
  }
  return "pending";
}

/**
 * Returns normalized payment kind.
 * @param {unknown} value
 * @returns {"plan_purchase"|"wallet_topup"}
 */
function normalizeKind(value) {
  return String(value || "").trim().toLowerCase() === "wallet_topup"
    ? "wallet_topup"
    : "plan_purchase";
}

/**
 * Returns clone-safe transaction payload.
 * @param {object|null|undefined} entry
 * @returns {object|null}
 */
function toPublicTransaction(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  return {
    qrId: toSafeString(entry.qrId, 140),
    orderId: toSafeString(entry.orderId, 140),
    paymentId: toSafeString(entry.paymentId, 140),
    userId: toSafeString(entry.userId, 180),
    amountInr: toSafeAmountInr(entry.amountInr),
    kind: normalizeKind(entry.kind),
    status: normalizeStatus(entry.status),
    providerStatus: toSafeString(entry.providerStatus, 80),
    providerEvent: toSafeString(entry.providerEvent, 80),
    failureReason: toSafeString(entry.failureReason, 220),
    createdAt: Math.max(0, Number(entry.createdAt) || 0),
    updatedAt: Math.max(0, Number(entry.updatedAt) || 0),
    closeByMs: Math.max(0, Number(entry.closeByMs) || 0),
    paidAt: Math.max(0, Number(entry.paidAt) || 0)
  };
}

/**
 * Removes stale tracked transactions.
 * @param {number=} nowMs
 */
function pruneTransactions(nowMs = Date.now()) {
  for (const [qrId, entry] of transactionsByQrId.entries()) {
    const updatedAt = Number(entry?.updatedAt || entry?.createdAt || 0);
    const closeByMs = Number(entry?.closeByMs || 0);
    const isPending = normalizeStatus(entry?.status) === "pending";

    const ageExceeded = updatedAt > 0 && nowMs - updatedAt > TRANSACTION_TTL_MS;
    const stalePending = isPending && closeByMs > 0 && nowMs - closeByMs > TRANSACTION_TTL_MS;

    if (!ageExceeded && !stalePending) {
      continue;
    }

    const orderId = toSafeString(entry?.orderId, 140);
    const paymentId = toSafeString(entry?.paymentId, 140);

    transactionsByQrId.delete(qrId);
    if (orderId && qrIdByOrderId.get(orderId) === qrId) {
      qrIdByOrderId.delete(orderId);
    }
    if (paymentId && qrIdByPaymentId.get(paymentId) === qrId) {
      qrIdByPaymentId.delete(paymentId);
    }
  }
}

/**
 * Resolves transaction candidate by references or user+amount fallback.
 * @param {{qrId?:string,orderId?:string,paymentId?:string,userId?:string,amountInr?:number}} refs
 * @returns {{entry:object|null,matchedBy:string}}
 */
function resolveTrackedTransaction(refs = {}) {
  pruneTransactions();

  const qrId = toSafeString(refs.qrId, 140);
  if (qrId && transactionsByQrId.has(qrId)) {
    return {
      entry: transactionsByQrId.get(qrId),
      matchedBy: "qrId"
    };
  }

  const orderId = toSafeString(refs.orderId, 140);
  if (orderId) {
    const mappedQrId = qrIdByOrderId.get(orderId);
    if (mappedQrId && transactionsByQrId.has(mappedQrId)) {
      return {
        entry: transactionsByQrId.get(mappedQrId),
        matchedBy: "orderId"
      };
    }
  }

  const paymentId = toSafeString(refs.paymentId, 140);
  if (paymentId) {
    const mappedQrId = qrIdByPaymentId.get(paymentId);
    if (mappedQrId && transactionsByQrId.has(mappedQrId)) {
      return {
        entry: transactionsByQrId.get(mappedQrId),
        matchedBy: "paymentId"
      };
    }
  }

  const fallbackUserId = toSafeString(refs.userId, 180).toLowerCase();
  const fallbackAmount = toSafeAmountInr(refs.amountInr);
  if (!fallbackUserId || fallbackAmount <= 0) {
    return {
      entry: null,
      matchedBy: "none"
    };
  }

  const nowMs = Date.now();
  let best = null;
  for (const entry of transactionsByQrId.values()) {
    const entryStatus = normalizeStatus(entry?.status);
    const entryUser = toSafeString(entry?.userId, 180).toLowerCase();
    const entryAmount = toSafeAmountInr(entry?.amountInr);
    const entryUpdatedAt = Number(entry?.updatedAt || entry?.createdAt || 0);

    if (entryStatus !== "pending") {
      continue;
    }
    if (!entryUser || entryUser !== fallbackUserId) {
      continue;
    }
    if (Math.abs(entryAmount - fallbackAmount) > 0.01) {
      continue;
    }
    if (!entryUpdatedAt || nowMs - entryUpdatedAt > PENDING_MATCH_WINDOW_MS) {
      continue;
    }

    if (!best || entryUpdatedAt > Number(best.updatedAt || best.createdAt || 0)) {
      best = entry;
    }
  }

  return {
    entry: best,
    matchedBy: best ? "userAmount" : "none"
  };
}

/**
 * Creates or updates one tracked transaction.
 * @param {object} payload
 * @returns {object|null}
 */
function upsertTrackedTransaction(payload = {}) {
  pruneTransactions();

  const directQrId = toSafeString(payload.qrId || payload.id, 140);
  const resolved = resolveTrackedTransaction(payload);
  const resolvedEntry = resolved.entry;
  const qrId = directQrId || toSafeString(resolvedEntry?.qrId, 140);

  if (!qrId) {
    return null;
  }

  const existing = transactionsByQrId.get(qrId) || resolvedEntry || null;
  const nowMs = Date.now();

  const next = {
    qrId,
    orderId: toSafeString(payload.orderId || existing?.orderId, 140),
    paymentId: toSafeString(payload.paymentId || existing?.paymentId, 140),
    userId: toSafeString(payload.userId || existing?.userId, 180),
    amountInr: toSafeAmountInr(payload.amountInr || existing?.amountInr),
    kind: normalizeKind(payload.kind || existing?.kind),
    status: normalizeStatus(payload.status || existing?.status || "pending"),
    providerStatus: toSafeString(payload.providerStatus || existing?.providerStatus, 80),
    providerEvent: toSafeString(payload.providerEvent || existing?.providerEvent, 80),
    failureReason: toSafeString(payload.failureReason || existing?.failureReason, 220),
    createdAt: toEpochMs(payload.createdAt) || Number(existing?.createdAt || nowMs),
    updatedAt: nowMs,
    closeByMs: toEpochMs(payload.closeByMs) || Number(existing?.closeByMs || 0),
    paidAt: toEpochMs(payload.paidAt) || Number(existing?.paidAt || 0)
  };

  if (next.status === "paid" && next.paidAt <= 0) {
    next.paidAt = nowMs;
  }

  const previous = transactionsByQrId.get(qrId);
  if (previous) {
    const prevOrderId = toSafeString(previous.orderId, 140);
    const prevPaymentId = toSafeString(previous.paymentId, 140);
    if (prevOrderId && qrIdByOrderId.get(prevOrderId) === qrId) {
      qrIdByOrderId.delete(prevOrderId);
    }
    if (prevPaymentId && qrIdByPaymentId.get(prevPaymentId) === qrId) {
      qrIdByPaymentId.delete(prevPaymentId);
    }
  }

  transactionsByQrId.set(qrId, next);
  if (next.orderId) {
    qrIdByOrderId.set(next.orderId, qrId);
  }
  if (next.paymentId) {
    qrIdByPaymentId.set(next.paymentId, qrId);
  }

  return toPublicTransaction(next);
}

/**
 * Registers pending transaction right after QR generation.
 * @param {object} payload
 * @returns {object|null}
 */
function recordPendingTransaction(payload = {}) {
  return upsertTrackedTransaction({
    ...payload,
    status: "pending",
    providerStatus: payload.providerStatus || "created",
    providerEvent: payload.providerEvent || "create_qr"
  });
}

/**
 * Updates transaction status from provider QR status polling.
 * @param {object} payload
 * @returns {object|null}
 */
function updateTransactionFromQrStatus(payload = {}) {
  const providerStatus = toSafeString(payload.providerStatus || "", 80).toLowerCase();
  const paid = Boolean(payload.paid);

  let status = "pending";
  if (paid) {
    status = "paid";
  } else if (providerStatus === "closed") {
    status = "closed";
  } else if (providerStatus === "expired") {
    status = "expired";
  } else if (providerStatus === "failed") {
    status = "failed";
  }

  return upsertTrackedTransaction({
    ...payload,
    status,
    providerStatus: providerStatus || (paid ? "captured" : "active"),
    providerEvent: payload.providerEvent || "qr_status"
  });
}

/**
 * Marks tracked transaction as paid from webhook/verification callback.
 * @param {object} payload
 * @returns {{transaction:object|null,matchedBy:string}}
 */
function markTrackedTransactionPaid(payload = {}) {
  const resolved = resolveTrackedTransaction(payload);
  const fallbackQrId = toSafeString(payload.qrId || resolved.entry?.qrId, 140);

  if (!fallbackQrId) {
    return {
      transaction: null,
      matchedBy: resolved.matchedBy
    };
  }

  const transaction = upsertTrackedTransaction({
    ...payload,
    qrId: fallbackQrId,
    status: "paid",
    providerStatus: payload.providerStatus || "captured",
    providerEvent: payload.providerEvent || "webhook"
  });

  return {
    transaction,
    matchedBy: resolved.matchedBy === "none"
      ? (payload.qrId ? "qrId" : "created")
      : resolved.matchedBy
  };
}

/**
 * Returns tracked transaction snapshot by qr id.
 * @param {string} qrId
 * @returns {object|null}
 */
function getTrackedTransactionByQrId(qrId) {
  pruneTransactions();
  const safeQrId = toSafeString(qrId, 140);
  if (!safeQrId) {
    return null;
  }

  return toPublicTransaction(transactionsByQrId.get(safeQrId));
}

/**
 * Returns tracked transaction snapshot resolved by refs.
 * @param {{qrId?:string,orderId?:string,paymentId?:string,userId?:string,amountInr?:number}} refs
 * @returns {{transaction:object|null,matchedBy:string}}
 */
function getTrackedTransactionByRefs(refs = {}) {
  const resolved = resolveTrackedTransaction(refs);
  return {
    transaction: toPublicTransaction(resolved.entry),
    matchedBy: resolved.matchedBy
  };
}

module.exports = {
  recordPendingTransaction,
  updateTransactionFromQrStatus,
  markTrackedTransactionPaid,
  getTrackedTransactionByQrId,
  getTrackedTransactionByRefs
};
