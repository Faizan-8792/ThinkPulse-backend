"use strict";

const ALLOWED_AMOUNTS_INR = Object.freeze([10, 20]);

const PLAN_BY_AMOUNT = Object.freeze({
  10: "basic",
  20: "premium"
});

/**
 * Returns normalized INR amount when allowed, else null.
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

  return ALLOWED_AMOUNTS_INR.includes(rounded) ? rounded : null;
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
  return PLAN_BY_AMOUNT[normalized] || null;
}

module.exports = {
  ALLOWED_AMOUNTS_INR,
  normalizeAmountInr,
  toPaise,
  fromPaise,
  resolvePlanByAmount
};
