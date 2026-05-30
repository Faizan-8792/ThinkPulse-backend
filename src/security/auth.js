"use strict";

/**
 * @file auth.js
 * @description Request authentication and role-resolution middleware for the
 * ThinkPulse backend API.
 *
 * Responsibilities:
 *   - Validates incoming Bearer tokens against the Google OAuth userinfo
 *     endpoint and caches results in a short-lived in-memory TTL store to
 *     avoid redundant network calls on every request.
 *   - Resolves the caller's role (admin / premium / user) by checking a
 *     static admin email list and the Supabase plan state table.
 *   - Enforces account-level access controls (blocked / deleted accounts).
 *   - Exports Express middleware factories: `authenticateRequest`,
 *     `requireRole`, and `requireSelfOrAdmin`.
 */

const {
  getGlobalJsonConfig,
  getUserPlanState
} = require("../payments/supabase_store");
const {
  InMemoryTtlStore
} = require("./in_memory_ttl_store");
const {
  logSecurityEvent
} = require("./logger");
const {
  verifyDemoSessionToken,
  looksLikeDemoSessionToken
} = require("./demo_session");

// ─── Constants ────────────────────────────────────────────────────────────────

/** Google OAuth v3 userinfo endpoint used to verify access tokens. */
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

/** Prefix for per-user account status keys stored in the app_settings table. */
const USER_ACCOUNT_STATUS_SETTING_PREFIX = "user_account_status:";

/**
 * Hardcoded admin email addresses kept for local-dev safety. Production
 * deployments should grant admin via the THINKPULSE_ADMIN_EMAILS env var
 * so the list can be rotated without a redeploy. A one-time startup
 * warning is emitted when production relies on these defaults.
 */
const DEFAULT_ADMIN_EMAILS = [
  "saifullahfaizan786@gmail.com",
  "saifullahfaizan.23@nshm.edu.in"
];

/**
 * Short-lived in-memory cache for validated Google token → identity mappings.
 * Reduces latency and avoids hitting the Google userinfo endpoint on every
 * authenticated API request within the same service worker process lifetime.
 */
const tokenValidationCache = new InMemoryTtlStore({
  maxEntries: 4000,
  sweepIntervalMs: 60000
});

/**
 * Parses the THINKPULSE_ADMIN_EMAILS and ADMIN_EMAILS environment variables
 * into a deduplicated array of normalised email strings. Supports both
 * comma-separated and newline-separated values.
 *
 * @returns {string[]}
 */
function parseEnvEmailList() {
  const source = [
    String(process.env.THINKPULSE_ADMIN_EMAILS || "").trim(),
    String(process.env.ADMIN_EMAILS || "").trim()
  ].filter(Boolean).join(",");
  const seen = new Set();
  const out = [];

  for (const piece of source.split(/\r?\n|,/g)) {
    const email = normalizeEmail(piece);
    if (!email || seen.has(email)) {
      continue;
    }
    seen.add(email);
    out.push(email);
  }

  return out;
}

/**
 * Merged set of all admin emails: hardcoded defaults plus any addresses
 * supplied via environment variables. Built once at module load time.
 */
const adminEmailSet = new Set([
  ...DEFAULT_ADMIN_EMAILS.map((value) => normalizeEmail(value)).filter(Boolean),
  ...parseEnvEmailList()
]);

if (
  String(process.env.NODE_ENV || "").trim().toLowerCase() === "production" &&
  parseEnvEmailList().length === 0
) {
  console.warn(
    "[auth] Production deployment is relying on the hardcoded DEFAULT_ADMIN_EMAILS list. " +
      "Set THINKPULSE_ADMIN_EMAILS (or ADMIN_EMAILS) to manage admins via env config."
  );
}

/**
 * Normalises an email address to lowercase and trims whitespace.
 * Returns an empty string if the value does not contain "@".
 *
 * @param {unknown} value
 * @returns {string}
 */
function normalizeEmail(value) {
  const safe = String(value || "").trim().toLowerCase().slice(0, 180);
  return safe.includes("@") ? safe : "";
}

/**
 * Extracts the raw token from an "Authorization: Bearer <token>" header value.
 * Returns an empty string if the header is missing or malformed.
 *
 * @param {unknown} value
 * @returns {string}
 */
function normalizeBearerToken(value) {
  const raw = String(value || "").trim();
  if (!/^bearer\s+/i.test(raw)) {
    return "";
  }
  return raw.replace(/^bearer\s+/i, "").trim();
}

/**
 * Coerces an arbitrary role string to one of the three recognised values.
 * Any unrecognised input falls back to "user".
 *
 * @param {unknown} value
 * @returns {"admin"|"premium"|"user"}
 */
function normalizeRole(value) {
  const safe = String(value || "").trim().toLowerCase();
  if (safe === "admin" || safe === "premium" || safe === "user") {
    return safe;
  }
  return "user";
}

/**
 * Returns a numeric rank for a role string, used for minimum-role comparisons.
 * admin = 3, premium = 2, user = 1.
 *
 * @param {unknown} value
 * @returns {number}
 */
function roleRank(value) {
  const role = normalizeRole(value);
  if (role === "admin") {
    return 3;
  }
  if (role === "premium") {
    return 2;
  }
  return 1;
}

function normalizeAccountStatusRecord(email, value = null) {
  const source = value && typeof value === "object" ? value : {};
  const status = String(source.status || "").trim().toLowerCase();
  const normalizedStatus = status === "blocked" || status === "deleted" ? status : "active";
  const apiBlocked = Boolean(source.apiBlocked || source.api_blocked);
  return {
    email: normalizeEmail(email),
    status: normalizedStatus,
    blocked: normalizedStatus === "blocked",
    deleted: normalizedStatus === "deleted",
    apiBlocked,
    apiBlockedAt: apiBlocked ? Math.max(0, Number(source.apiBlockedAt) || 0) : 0,
    apiBlockedByEmail: apiBlocked ? normalizeEmail(source.apiBlockedByEmail || source.apiBlockedBy || "") : "",
    apiBlockNote: apiBlocked ? String(source.apiBlockNote || source.apiReason || "").trim().slice(0, 220) : "",
    note: String(source.note || "").trim().slice(0, 220)
  };
}

async function getAccountStatusForAuth(email) {
  const safeEmail = normalizeEmail(email);
  if (!safeEmail) {
    return normalizeAccountStatusRecord("");
  }

  try {
    const stored = await getGlobalJsonConfig(`${USER_ACCOUNT_STATUS_SETTING_PREFIX}${safeEmail}`);
    return normalizeAccountStatusRecord(safeEmail, stored?.found ? stored.value : null);
  } catch (_error) {
    return normalizeAccountStatusRecord(safeEmail);
  }
}

function isAccountStatusBypassPath(req) {
  const method = String(req.method || "").trim().toUpperCase();
  const path = String(req.path || req.originalUrl || req.url || "").trim().toLowerCase();
  if (method === "GET" && /^\/users\/status\/[^/]+$/.test(path)) {
    return true;
  }
  if (method === "POST" && path === "/users/upsert") {
    return true;
  }
  return false;
}

async function resolveTrustedRole(email) {
  const safeEmail = normalizeEmail(email);
  if (!safeEmail) {
    return "user";
  }

  if (adminEmailSet.has(safeEmail)) {
    return "admin";
  }

  try {
    const planState = await getUserPlanState({ userId: safeEmail });
    const plan = String(planState?.plan || "").trim().toLowerCase();
    if (plan === "admin") {
      return "admin";
    }
    if (plan === "premium") {
      return "premium";
    }
  } catch (_error) {
  }

  return "user";
}

async function fetchGoogleIdentity(token) {
  const response = await fetch(GOOGLE_USERINFO_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json"
    },
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`Google token verification failed (${response.status}).`);
  }

  const payload = await response.json();
  const email = normalizeEmail(payload?.email);
  if (!email) {
    throw new Error("Google token did not resolve to a valid email.");
  }

  const role = await resolveTrustedRole(email);
  return {
    email,
    role,
    plan: role === "premium" ? "premium" : role === "admin" ? "admin" : "user",
    profileId: String(payload?.sub || "").trim(),
    fullName: String(payload?.name || "").trim(),
    picture: String(payload?.picture || "").trim()
  };
}

/**
 * Resolves an identity record from a verified demo session token. Demo
 * sessions always resolve to the regular "user" role to ensure reviewers
 * experience the same feature set as a real end-user.
 *
 * @param {string} token
 * @returns {Promise<object|null>}
 */
async function resolveDemoIdentity(token) {
  const claims = verifyDemoSessionToken(token);
  if (!claims) {
    return null;
  }

  return {
    email: claims.email,
    role: "user",
    plan: "user",
    profileId: `demo_${claims.email}`,
    fullName: "",
    picture: "",
    issuedAt: claims.issuedAt,
    expiresAt: claims.expiresAt,
    sessionType: "demo"
  };
}

async function validateAccessToken(token) {
  const safeToken = String(token || "").trim();
  if (!safeToken) {
    throw new Error("Missing bearer token.");
  }

  // Cache TTL is intentionally short so admin-driven plan/role changes
  // (set-plan, set-role, block) propagate to in-flight clients quickly.
  const cacheTtlMs = 5 * 1000;

  // Demo session tokens are HMAC-signed locally and verified without any
  // external network call. They must be checked first so they never hit the
  // Google userinfo endpoint.
  if (looksLikeDemoSessionToken(safeToken)) {
    const cached = tokenValidationCache.get(safeToken);
    if (cached) {
      return cached;
    }
    const identity = await resolveDemoIdentity(safeToken);
    if (!identity) {
      throw new Error("Invalid or expired demo session token.");
    }
    tokenValidationCache.set(safeToken, identity, cacheTtlMs);
    return identity;
  }

  const cached = tokenValidationCache.get(safeToken);
  if (cached) {
    return cached;
  }

  const identity = await fetchGoogleIdentity(safeToken);
  tokenValidationCache.set(safeToken, identity, cacheTtlMs);
  return identity;
}

/**
 * Removes a single token from the validation cache. Useful when an admin
 * action invalidates the cached role/plan for a specific session.
 *
 * @param {string} token
 */
function invalidateAuthCacheForToken(token) {
  const safeToken = String(token || "").trim();
  if (!safeToken) {
    return;
  }
  tokenValidationCache.delete(safeToken);
}

/**
 * Drops every cached token-to-identity mapping for the given email so the
 * next request re-resolves role/plan from Supabase. Called after admin
 * writes (set-plan, set-role, block, credit-wallet) that change a user's
 * effective entitlements.
 *
 * @param {string} email
 */
function invalidateAuthCacheForEmail(email) {
  const safeEmail = normalizeEmail(email);
  if (!safeEmail) {
    return;
  }
  for (const [token, identity] of tokenValidationCache.entries()) {
    if (normalizeEmail(identity?.email) === safeEmail) {
      tokenValidationCache.delete(token);
    }
  }
}

function rejectAuthRequest(req, res, reason, statusCode = 401) {
  if (typeof req.logSecurity === "function") {
    req.logSecurity("auth_rejected", {
      reason: String(reason || "unauthorized").trim(),
      claimedEmail: normalizeEmail(req.headers["x-thinkpulse-user-email"] || "")
    }, "warn");
  } else {
    logSecurityEvent("auth_rejected", {
      reason: String(reason || "unauthorized").trim(),
      path: String(req.originalUrl || req.url || "").trim(),
      method: String(req.method || "").trim().toUpperCase(),
      ip: String(req.ip || req.socket?.remoteAddress || "").trim()
    }, "warn");
  }

  res.status(statusCode).json({
    ok: false,
    error: statusCode === 403 ? "Forbidden." : "Unauthorized."
  });
}

function authenticateRequest() {
  return async (req, res, next) => {
    try {
      const token = normalizeBearerToken(req.headers.authorization);
      if (!token) {
        rejectAuthRequest(req, res, "missing_bearer_token", 401);
        return;
      }

      const user = await validateAccessToken(token);
      const claimedEmail = normalizeEmail(req.headers["x-thinkpulse-user-email"] || "");
      if (claimedEmail && claimedEmail !== user.email) {
        rejectAuthRequest(req, res, "claimed_email_mismatch", 401);
        return;
      }

      req.user = user;
      req.authToken = token;
      if (user.role !== "admin" && !isAccountStatusBypassPath(req)) {
        const accountStatus = await getAccountStatusForAuth(user.email);
        if (accountStatus.blocked || accountStatus.deleted) {
          rejectAuthRequest(
            req,
            res,
            accountStatus.deleted ? "account_deleted" : "account_blocked",
            403
          );
          return;
        }
      }
      next();
    } catch (error) {
      rejectAuthRequest(req, res, error?.message || "token_validation_failed", 401);
    }
  };
}

function requireRole(minimumRole = "user") {
  return (req, res, next) => {
    const requiredRank = roleRank(minimumRole);
    const actualRank = roleRank(req.user?.role || "user");
    if (actualRank < requiredRank) {
      rejectAuthRequest(req, res, `insufficient_role:${minimumRole}`, 403);
      return;
    }
    next();
  };
}

function extractScopedEmail(req, fields = []) {
  for (const field of Array.isArray(fields) ? fields : []) {
    const sourceType = String(field?.source || "").trim().toLowerCase();
    const key = String(field?.key || "").trim();
    if (!sourceType || !key) {
      continue;
    }

    const container = sourceType === "params"
      ? req.params
      : sourceType === "query"
        ? req.query
        : req.body;
    const email = normalizeEmail(container?.[key]);
    if (email) {
      return email;
    }
  }

  return "";
}

function requireSelfOrAdmin(fields = []) {
  return (req, res, next) => {
    const userEmail = normalizeEmail(req.user?.email || "");
    if (!userEmail) {
      rejectAuthRequest(req, res, "missing_user_email", 401);
      return;
    }

    if (normalizeRole(req.user?.role) === "admin") {
      next();
      return;
    }

    const scopedEmail = extractScopedEmail(req, fields);
    if (scopedEmail && scopedEmail !== userEmail) {
      rejectAuthRequest(req, res, "self_scope_mismatch", 403);
      return;
    }

    next();
  };
}

module.exports = {
  authenticateRequest,
  requireRole,
  requireSelfOrAdmin,
  resolveTrustedRole,
  normalizeEmail,
  invalidateAuthCacheForEmail,
  invalidateAuthCacheForToken
};
