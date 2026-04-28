"use strict";

const {
  getUserPlanState
} = require("../payments/supabase_store");
const {
  InMemoryTtlStore
} = require("./in_memory_ttl_store");
const {
  logSecurityEvent
} = require("./logger");

const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";
const DEFAULT_ADMIN_EMAILS = [
  "saifullahfaizan786@gmail.com",
  "saifullahfaizan.23@nshm.edu.in"
];
const tokenValidationCache = new InMemoryTtlStore({
  maxEntries: 4000,
  sweepIntervalMs: 60000
});

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

const adminEmailSet = new Set([
  ...DEFAULT_ADMIN_EMAILS.map((value) => normalizeEmail(value)).filter(Boolean),
  ...parseEnvEmailList()
]);

function normalizeEmail(value) {
  const safe = String(value || "").trim().toLowerCase().slice(0, 180);
  return safe.includes("@") ? safe : "";
}

function normalizeBearerToken(value) {
  const raw = String(value || "").trim();
  if (!/^bearer\s+/i.test(raw)) {
    return "";
  }
  return raw.replace(/^bearer\s+/i, "").trim();
}

function normalizeRole(value) {
  const safe = String(value || "").trim().toLowerCase();
  if (safe === "admin" || safe === "premium" || safe === "user") {
    return safe;
  }
  return "user";
}

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

async function validateAccessToken(token) {
  const safeToken = String(token || "").trim();
  if (!safeToken) {
    throw new Error("Missing bearer token.");
  }

  const cached = tokenValidationCache.get(safeToken);
  if (cached) {
    return cached;
  }

  const identity = await fetchGoogleIdentity(safeToken);
  tokenValidationCache.set(safeToken, identity, 60 * 1000);
  return identity;
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
  normalizeEmail
};
