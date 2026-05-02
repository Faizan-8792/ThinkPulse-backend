"use strict";

const ALLOWED_AMOUNTS_INR = Object.freeze([10, 50, 100, 250, 500, 1000, 10000]);
const MIN_WALLET_TOPUP_INR = 10;
const MAX_WALLET_TOPUP_INR = 10000;

/**
 * Returns normalized integer INR amount for plan purchase amounts, else null.
 * @param {unknown} value
 * @returns {number|null}
 */
function normalizeAmountInr(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }

  const rounded = Math.round(numeric);
  if (Math.abs(rounded - numeric) > 1e-9) {
    return null;
  }

  if (rounded < MIN_WALLET_TOPUP_INR || rounded > MAX_WALLET_TOPUP_INR) {
    return null;
  }

  return rounded;
}

/**
 * Returns normalized integer INR amount for wallet top-up range, else null.
 * @param {unknown} value
 * @returns {number|null}
 */
function normalizeWalletTopupAmountInr(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }

  const rounded = Math.round(numeric);
  if (Math.abs(rounded - numeric) > 1e-9) {
    return null;
  }

  if (rounded < MIN_WALLET_TOPUP_INR || rounded > MAX_WALLET_TOPUP_INR) {
    return null;
  }

  return rounded;
}

/**
 * Converts INR amount to paise.
 * @param {number} amountInr
 * @returns {number}
 */
function toPaise(amountInr) {
  return Math.round(Number(amountInr) * 100);
}

/**
 * Converts paise amount to INR with 2 decimal places precision.
 * @param {number} amountPaise
 * @returns {number}
 */
function fromPaise(amountPaise) {
  const numeric = Number(amountPaise);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.round((numeric / 100) * 100) / 100;
}

/**
 * Resolves plan name for a supported INR amount.
 * @param {number} amountInr
 * @returns {"basic"|"premium"|null}
 */
function resolvePlanByAmount(amountInr) {
  const normalized = normalizeAmountInr(amountInr);
  if (!normalized) {
    return null;
  }
  return normalized >= 100 ? "premium" : "basic";
}

module.exports = {
  ALLOWED_AMOUNTS_INR,
  MIN_WALLET_TOPUP_INR,
  MAX_WALLET_TOPUP_INR,
  normalizeAmountInr,
  normalizeWalletTopupAmountInr,
  toPaise,
  fromPaise,
  resolvePlanByAmount
};
