"use strict";

/**
 * @file demo_session.js
 * @description Demo session token issuer and verifier for ThinkPulse.
 *
 * Issues HMAC-SHA256 signed tokens to pre-approved demo accounts so they can
 * authenticate to the backend without a Google OAuth flow. Demo tokens are
 * accepted by the standard authenticateRequest middleware alongside Google
 * Bearer tokens.
 *
 * Token format: `demo:v1:<base64url(payload)>.<base64url(signature)>`
 * Payload: `{ email, iat, exp, v: 1 }`
 *
 * The HMAC secret is read from `DEMO_SESSION_SECRET`. If not configured, a
 * deterministic but unique fallback is derived from other server secrets so
 * tokens remain valid across restarts within the same deployment.
 */

const crypto = require("crypto");

// ─── Configuration ────────────────────────────────────────────────────────────

/** Default lifetime for issued demo tokens. */
const DEFAULT_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Maximum age (from original issuance) for which an expired token may still be
 * silently refreshed into a fresh one. As long as a client refreshes within
 * this window, the session effectively never forces a manual re-login. After
 * this window the user must sign in again.
 */
const REFRESH_GRACE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

/**
 * Hardcoded fallback demo accounts.
 *
 * SECURITY: This fallback is only honoured when NODE_ENV is not "production".
 * Production deployments MUST configure DEMO_ACCOUNTS explicitly. If the env
 * var is missing in production, demo sign-in is disabled outright.
 */
const DEFAULT_DEMO_ACCOUNTS = [
  { email: "admin@gmail.com", password: "admin@8792187937" }
];

/**
 * Resolves the HMAC secret used to sign demo tokens. Prefers the explicit
 * `DEMO_SESSION_SECRET` env var. Falls back to a derived secret from other
 * server-side keys so dev environments still work without extra config.
 *
 * @returns {string}
 */
function resolveSecret() {
  const explicit = String(process.env.DEMO_SESSION_SECRET || "").trim();
  if (explicit) {
    return explicit;
  }
  const fallback = [
    String(process.env.RAZORPAY_KEY_SECRET || ""),
    String(process.env.STRIPE_LIVE_SECRET_KEY || ""),
    String(process.env.STRIPE_TEST_SECRET_KEY || ""),
    String(process.env.SUPABASE_SERVICE_ROLE_KEY || ""),
    "thinkpulse-demo-session-fallback"
  ].filter(Boolean).join("::");
  return crypto.createHash("sha256").update(fallback).digest("hex");
}

const TOKEN_SECRET = resolveSecret();

/**
 * Parses the `DEMO_ACCOUNTS` env var into a list of credential pairs.
 * Format: `email1:password1,email2:password2` (newline or comma separated).
 *
 * @returns {Array<{email:string,password:string}>}
 */
function parseDemoAccountsEnv() {
  const raw = String(process.env.DEMO_ACCOUNTS || "").trim();
  if (!raw) {
    return [];
  }
  const pairs = [];
  for (const piece of raw.split(/\r?\n|,/g)) {
    const trimmed = String(piece || "").trim();
    if (!trimmed) {
      continue;
    }
    const colonIndex = trimmed.indexOf(":");
    if (colonIndex <= 0) {
      continue;
    }
    const email = trimmed.slice(0, colonIndex).trim().toLowerCase();
    const password = trimmed.slice(colonIndex + 1).trim();
    if (email && password && email.includes("@")) {
      pairs.push({ email, password });
    }
  }
  return pairs;
}

/**
 * Loads the active demo account list. Env-configured accounts take precedence;
 * the hardcoded fallback is only honoured outside of production so reviewers
 * and local developers can sign in without configuring `DEMO_ACCOUNTS`.
 *
 * In production, demo sign-in is disabled when `DEMO_ACCOUNTS` is not set.
 *
 * @returns {Array<{email:string,password:string}>}
 */
function getDemoAccounts() {
  const fromEnv = parseDemoAccountsEnv();
  if (fromEnv.length > 0) {
    return fromEnv;
  }
  if (String(process.env.NODE_ENV || "").trim().toLowerCase() === "production") {
    return [];
  }
  return DEFAULT_DEMO_ACCOUNTS;
}

/**
 * Constant-time string comparison to prevent timing attacks during password
 * validation.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeStringCompare(a, b) {
  const left = Buffer.from(String(a || ""), "utf8");
  const right = Buffer.from(String(b || ""), "utf8");
  if (left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

/**
 * Validates user-supplied credentials against the configured demo accounts.
 *
 * @param {string} email
 * @param {string} password
 * @returns {{ok:true,email:string}|{ok:false,error:string}}
 */
function validateDemoCredentials(email, password) {
  const safeEmail = String(email || "").trim().toLowerCase();
  const safePassword = String(password || "");
  if (!safeEmail || !safePassword || !safeEmail.includes("@")) {
    return { ok: false, error: "Email and password are required." };
  }

  const accounts = getDemoAccounts();
  if (accounts.length === 0) {
    return { ok: false, error: "Demo sign-in is not enabled on this server." };
  }

  for (const account of accounts) {
    if (account.email === safeEmail && safeStringCompare(account.password, safePassword)) {
      return { ok: true, email: safeEmail };
    }
  }
  return { ok: false, error: "Invalid email or password." };
}

/**
 * Encodes a Buffer or string as URL-safe base64.
 *
 * @param {Buffer|string} value
 * @returns {string}
 */
function base64UrlEncode(value) {
  return Buffer.from(value).toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/**
 * Decodes a URL-safe base64 string into a Buffer.
 *
 * @param {string} value
 * @returns {Buffer}
 */
function base64UrlDecode(value) {
  const padded = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + "=".repeat(padLength), "base64");
}

/**
 * Signs a JSON payload using HMAC-SHA256 with the resolved secret.
 *
 * @param {object} payload
 * @returns {string} URL-safe base64 signature
 */
function signPayload(payload) {
  const json = JSON.stringify(payload);
  const encoded = base64UrlEncode(json);
  const hmac = crypto.createHmac("sha256", TOKEN_SECRET).update(encoded).digest();
  return base64UrlEncode(hmac);
}

/**
 * Issues a signed demo session token for a validated email.
 *
 * @param {string} email
 * @param {{ttlMs?:number}} options
 * @returns {{token:string,expiresAt:number,issuedAt:number}}
 */
function issueDemoSessionToken(email, options = {}) {
  const safeEmail = String(email || "").trim().toLowerCase();
  if (!safeEmail || !safeEmail.includes("@")) {
    throw new Error("Valid email is required to issue a demo session token.");
  }

  const ttlMs = Math.max(60_000, Number(options?.ttlMs) || DEFAULT_TOKEN_TTL_MS);
  const issuedAt = Date.now();
  const expiresAt = issuedAt + ttlMs;
  const payload = {
    v: 1,
    email: safeEmail,
    iat: issuedAt,
    exp: expiresAt
  };

  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = signPayload(payload);
  const token = `demo:v1:${encodedPayload}.${signature}`;

  return { token, expiresAt, issuedAt };
}

/**
 * Parses a demo token and verifies its HMAC signature WITHOUT enforcing
 * expiry. Returns the embedded claims or `null` when the token is malformed
 * or the signature does not match. Expiry must be enforced by the caller.
 *
 * @param {string} token
 * @returns {{email:string,issuedAt:number,expiresAt:number}|null}
 */
function parseSignedDemoToken(token) {
  const raw = String(token || "").trim();
  if (!raw.startsWith("demo:v1:")) {
    return null;
  }

  const body = raw.slice("demo:v1:".length);
  const dotIndex = body.indexOf(".");
  if (dotIndex <= 0 || dotIndex === body.length - 1) {
    return null;
  }

  const encodedPayload = body.slice(0, dotIndex);
  const providedSignature = body.slice(dotIndex + 1);

  let payload;
  try {
    const json = base64UrlDecode(encodedPayload).toString("utf8");
    payload = JSON.parse(json);
  } catch (_error) {
    return null;
  }

  const expectedSignature = signPayload(payload);
  const providedBuf = Buffer.from(providedSignature, "utf8");
  const expectedBuf = Buffer.from(expectedSignature, "utf8");
  if (providedBuf.length !== expectedBuf.length) {
    return null;
  }
  if (!crypto.timingSafeEqual(providedBuf, expectedBuf)) {
    return null;
  }

  const safeEmail = String(payload?.email || "").trim().toLowerCase();
  const issuedAt = Math.max(0, Number(payload?.iat) || 0);
  const expiresAt = Math.max(0, Number(payload?.exp) || 0);
  if (!safeEmail || !safeEmail.includes("@") || !expiresAt) {
    return null;
  }

  return { email: safeEmail, issuedAt, expiresAt };
}

/**
 * Verifies a demo session token and returns the embedded identity.
 * Returns `null` if the token is malformed, expired, or fails HMAC checks.
 *
 * @param {string} token
 * @returns {{email:string,issuedAt:number,expiresAt:number}|null}
 */
function verifyDemoSessionToken(token) {
  const claims = parseSignedDemoToken(token);
  if (!claims) {
    return null;
  }
  if (Date.now() >= claims.expiresAt) {
    return null;
  }
  return claims;
}

/**
 * Re-issues a fresh demo session token from an existing one. The supplied
 * token must have a valid signature and must have been originally issued
 * within `REFRESH_GRACE_MS` — it may itself be expired (so a returning user
 * whose 30-day token lapsed can still renew silently without re-entering an
 * OTP). Returns `null` when the token is invalid or too old to refresh.
 *
 * @param {string} token
 * @param {{ttlMs?:number}} options
 * @returns {{token:string,expiresAt:number,issuedAt:number,email:string}|null}
 */
function refreshDemoSessionToken(token, options = {}) {
  const claims = parseSignedDemoToken(token);
  if (!claims) {
    return null;
  }
  const originIat = claims.issuedAt || claims.expiresAt - DEFAULT_TOKEN_TTL_MS;
  if (originIat > 0 && Date.now() - originIat > REFRESH_GRACE_MS) {
    return null;
  }
  const issued = issueDemoSessionToken(claims.email, options);
  return { ...issued, email: claims.email };
}

/**
 * Returns true when the supplied token string looks like a demo session
 * token (regardless of validity). Used to route token validation to the
 * demo path instead of the Google OAuth path.
 *
 * @param {string} token
 * @returns {boolean}
 */
function looksLikeDemoSessionToken(token) {
  return String(token || "").trim().startsWith("demo:v1:");
}

module.exports = {
  validateDemoCredentials,
  issueDemoSessionToken,
  verifyDemoSessionToken,
  refreshDemoSessionToken,
  looksLikeDemoSessionToken,
  DEFAULT_TOKEN_TTL_MS
};
