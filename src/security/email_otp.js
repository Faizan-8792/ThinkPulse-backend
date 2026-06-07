"use strict";

/**
 * @file email_otp.js
 * @description Email one-time-password (OTP) issuer, verifier, and delivery
 * for the ThinkPulse backend.
 *
 * Replaces the Google OAuth sign-in flow with passwordless email OTP:
 *   1. Client requests an OTP for an email -> a 6-digit code is generated,
 *      hashed, stored in a short-lived TTL store, and emailed via Resend.
 *   2. Client submits the email + code -> the code is verified and, on
 *      success, the caller is issued the same signed session token used by
 *      the legacy demo-session path so every downstream backend feature
 *      (user registry, rewards, billing, account status) keeps working
 *      unchanged.
 *
 * Codes are never stored in plaintext. Only an HMAC-SHA256 hash is kept in
 * memory alongside attempt counters to defend against brute force.
 */

const crypto = require("crypto");
const { Resend } = require("resend");
const { InMemoryTtlStore } = require("./in_memory_ttl_store");
const { logSecurityEvent } = require("./logger");

// ─── Configuration ────────────────────────────────────────────────────────────

/** OTP lifetime before it expires and must be re-requested. */
const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** Maximum verification attempts per issued code before it is invalidated. */
const MAX_VERIFY_ATTEMPTS = 5;

/** Minimum gap between OTP issuance for the same email (anti-spam). */
const RESEND_COOLDOWN_MS = 30 * 1000;

/** Number of digits in the generated OTP. */
const OTP_DIGITS = 6;

/**
 * In-memory store of pending OTP challenges keyed by normalized email.
 * Value: { codeHash, expiresAt, attempts, lastSentAt }.
 */
const otpStore = new InMemoryTtlStore({
  maxEntries: 20000,
  sweepIntervalMs: 60000
});

/**
 * Resolves the HMAC secret used to hash OTP codes at rest. Prefers an
 * explicit secret, falling back to a derived value from other server keys so
 * codes are never stored in plaintext even without extra configuration.
 *
 * @returns {string}
 */
function resolveOtpSecret() {
  const explicit = String(process.env.OTP_HASH_SECRET || process.env.DEMO_SESSION_SECRET || "").trim();
  if (explicit) {
    return explicit;
  }
  const fallback = [
    String(process.env.RESEND_API_KEY || ""),
    String(process.env.SUPABASE_SERVICE_ROLE_KEY || ""),
    "thinkpulse-email-otp-fallback"
  ].filter(Boolean).join("::");
  return crypto.createHash("sha256").update(fallback).digest("hex");
}

const OTP_SECRET = resolveOtpSecret();

let resendClient = null;
function getResendClient() {
  if (resendClient) {
    return resendClient;
  }
  const apiKey = String(process.env.RESEND_API_KEY || "").trim();
  if (!apiKey) {
    return null;
  }
  resendClient = new Resend(apiKey);
  return resendClient;
}

/**
 * Normalises an email address to a lowercase, trimmed identifier.
 *
 * @param {unknown} value
 * @returns {string}
 */
function normalizeEmail(value) {
  const safe = String(value || "").trim().toLowerCase().slice(0, 180);
  return safe.includes("@") ? safe : "";
}

/**
 * Generates a cryptographically-random numeric OTP code.
 *
 * @returns {string}
 */
function generateOtpCode() {
  const max = 10 ** OTP_DIGITS;
  const code = crypto.randomInt(0, max);
  return String(code).padStart(OTP_DIGITS, "0");
}

/**
 * Computes the at-rest HMAC hash of an OTP code bound to an email.
 *
 * @param {string} email
 * @param {string} code
 * @returns {string}
 */
function hashOtpCode(email, code) {
  return crypto
    .createHmac("sha256", OTP_SECRET)
    .update(`${email}:${code}`)
    .digest("hex");
}

/**
 * Returns true when email OTP delivery is configured (Resend key present).
 *
 * @returns {boolean}
 */
function isConfigured() {
  return Boolean(String(process.env.RESEND_API_KEY || "").trim());
}

/**
 * Builds the HTML body for the OTP email.
 *
 * @param {string} code
 * @returns {string}
 */
function buildOtpEmailHtml(code) {
  const minutes = Math.round(OTP_TTL_MS / 60000);
  return [
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;padding:24px;">',
    '<h2 style="color:#111;margin:0 0 12px;">ThinkPulse Login Verification</h2>',
    '<p style="color:#444;font-size:14px;margin:0 0 20px;">Use the verification code below to sign in. Do not share this code with anyone.</p>',
    `<div style="font-size:32px;font-weight:700;letter-spacing:8px;color:#111;background:#f4f4f5;border-radius:8px;padding:16px;text-align:center;">${code}</div>`,
    `<p style="color:#888;font-size:12px;margin:20px 0 0;">This code expires in ${minutes} minutes. If you did not request it, you can safely ignore this email.</p>`,
    "</div>"
  ].join("");
}

/**
 * Generates, stores, and emails an OTP code for the supplied email.
 *
 * @param {string} rawEmail
 * @returns {Promise<{ok:true,email:string,expiresAt:number}|{ok:false,error:string,status?:number}>}
 */
async function requestEmailOtp(rawEmail) {
  const email = normalizeEmail(rawEmail);
  if (!email) {
    return { ok: false, error: "A valid email address is required.", status: 400 };
  }

  if (!isConfigured()) {
    return { ok: false, error: "Email sign-in is not enabled on this server.", status: 503 };
  }

  const existing = otpStore.get(email);
  const now = Date.now();
  if (existing && now - Number(existing.lastSentAt || 0) < RESEND_COOLDOWN_MS) {
    const waitSeconds = Math.ceil((RESEND_COOLDOWN_MS - (now - Number(existing.lastSentAt || 0))) / 1000);
    return {
      ok: false,
      error: `Please wait ${waitSeconds}s before requesting another code.`,
      status: 429
    };
  }

  const code = generateOtpCode();
  const resend = getResendClient();
  if (!resend) {
    return { ok: false, error: "Email sign-in is not enabled on this server.", status: 503 };
  }

  const fromAddress = String(process.env.RESEND_FROM_EMAIL || "ThinkPulse <onboarding@resend.dev>").trim();
  try {
    const { error } = await resend.emails.send({
      from: fromAddress,
      to: [email],
      subject: "Your ThinkPulse login code",
      html: buildOtpEmailHtml(code)
    });
    if (error) {
      throw new Error(error.message || "Resend rejected the email.");
    }
  } catch (error) {
    logSecurityEvent("email_otp_send_failed", {
      claimedEmail: email,
      reason: error?.message || "unknown_error"
    }, "warn");
    return { ok: false, error: "Unable to send the verification email. Please try again.", status: 502 };
  }

  const expiresAt = now + OTP_TTL_MS;
  otpStore.set(
    email,
    {
      codeHash: hashOtpCode(email, code),
      expiresAt,
      attempts: 0,
      lastSentAt: now
    },
    OTP_TTL_MS
  );

  logSecurityEvent("email_otp_sent", { claimedEmail: email }, "info");
  return { ok: true, email, expiresAt };
}

/**
 * Verifies a submitted OTP code for an email.
 *
 * @param {string} rawEmail
 * @param {string} rawCode
 * @returns {{ok:true,email:string}|{ok:false,error:string,status?:number}}
 */
function verifyEmailOtp(rawEmail, rawCode) {
  const email = normalizeEmail(rawEmail);
  const code = String(rawCode || "").trim();
  if (!email || !code) {
    return { ok: false, error: "Email and verification code are required.", status: 400 };
  }

  const challenge = otpStore.get(email);
  if (!challenge) {
    return { ok: false, error: "This code has expired. Please request a new one.", status: 400 };
  }

  if (Date.now() >= Number(challenge.expiresAt || 0)) {
    otpStore.delete(email);
    return { ok: false, error: "This code has expired. Please request a new one.", status: 400 };
  }

  if (Number(challenge.attempts || 0) >= MAX_VERIFY_ATTEMPTS) {
    otpStore.delete(email);
    logSecurityEvent("email_otp_attempts_exceeded", { claimedEmail: email }, "warn");
    return { ok: false, error: "Too many incorrect attempts. Please request a new code.", status: 429 };
  }

  const providedHash = hashOtpCode(email, code);
  const expectedBuf = Buffer.from(String(challenge.codeHash || ""), "utf8");
  const providedBuf = Buffer.from(providedHash, "utf8");
  const matches =
    expectedBuf.length === providedBuf.length &&
    crypto.timingSafeEqual(expectedBuf, providedBuf);

  if (!matches) {
    challenge.attempts = Number(challenge.attempts || 0) + 1;
    otpStore.set(email, challenge, Math.max(1000, Number(challenge.expiresAt) - Date.now()));
    return { ok: false, error: "Invalid verification code.", status: 401 };
  }

  otpStore.delete(email);
  logSecurityEvent("email_otp_verified", { claimedEmail: email }, "info");
  return { ok: true, email };
}

module.exports = {
  requestEmailOtp,
  verifyEmailOtp,
  isConfigured,
  OTP_TTL_MS
};
