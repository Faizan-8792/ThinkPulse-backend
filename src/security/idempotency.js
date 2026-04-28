"use strict";

const crypto = require("crypto");
const {
  isConfigured: isSupabaseConfigured,
  getGlobalJsonConfig,
  upsertGlobalJsonConfig
} = require("../payments/supabase_store");
const {
  InMemoryTtlStore
} = require("./in_memory_ttl_store");
const {
  logSecurityEvent
} = require("./logger");

const idempotencyMemoryStore = new InMemoryTtlStore({
  maxEntries: 12000,
  sweepIntervalMs: 60000
});

function stableValue(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => stableValue(entry));
  }

  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .reduce((output, key) => {
        output[key] = stableValue(value[key]);
        return output;
      }, {});
  }

  return value;
}

function toHash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function normalizeIdempotencyKey(value) {
  return String(value || "").trim().slice(0, 240);
}

function buildStorageKey(scope, key) {
  return `idempotency:${String(scope || "generic").trim().toLowerCase()}:${toHash(key)}`;
}

function computeRequestFingerprint(req) {
  return toHash(
    JSON.stringify({
      method: String(req.method || "").trim().toUpperCase(),
      path: String(req.originalUrl || req.url || "").trim(),
      params: stableValue(req.params || {}),
      query: stableValue(req.query || {}),
      body: stableValue(req.body || {})
    })
  );
}

async function readIdempotencyRecord(scope, key) {
  const memoryKey = `${scope}:${key}`;
  const cached = idempotencyMemoryStore.get(memoryKey);
  if (cached && Number(cached.expiresAt || 0) > Date.now()) {
    return cached;
  }

  if (!isSupabaseConfigured()) {
    return null;
  }

  try {
    const stored = await getGlobalJsonConfig(buildStorageKey(scope, key));
    const value = stored?.found && stored.value && typeof stored.value === "object" ? stored.value : null;
    if (!value || Number(value.expiresAt || 0) <= Date.now()) {
      return null;
    }
    idempotencyMemoryStore.set(memoryKey, value, Math.max(1000, Number(value.expiresAt || 0) - Date.now()));
    return value;
  } catch (_error) {
    return null;
  }
}

async function writeIdempotencyRecord(scope, key, value, ttlMs) {
  const memoryKey = `${scope}:${key}`;
  const safeTtlMs = Math.max(1000, Number(ttlMs) || 5 * 60 * 1000);
  const record = {
    ...value,
    expiresAt: Date.now() + safeTtlMs
  };

  idempotencyMemoryStore.set(memoryKey, record, safeTtlMs);
  if (!isSupabaseConfigured()) {
    return record;
  }

  try {
    await upsertGlobalJsonConfig(buildStorageKey(scope, key), record);
  } catch (_error) {
  }

  return record;
}

function createIdempotencyMiddleware(options = {}) {
  const scope = String(options.scope || "generic").trim().toLowerCase() || "generic";
  const ttlMs = Math.max(1000, Number(options.ttlMs) || 10 * 60 * 1000);
  const deriveKey = typeof options.deriveKey === "function" ? options.deriveKey : null;
  const headerName = String(options.headerName || "idempotency-key").trim().toLowerCase() || "idempotency-key";

  return async (req, res, next) => {
    const derived = deriveKey ? deriveKey(req) : "";
    const providedKey = req.headers[headerName] || req.body?.idempotencyKey || derived;
    const key = normalizeIdempotencyKey(providedKey);
    if (!key) {
      next();
      return;
    }

    const fingerprint = computeRequestFingerprint(req);
    const existing = await readIdempotencyRecord(scope, key);
    if (existing) {
      if (String(existing.fingerprint || "") && String(existing.fingerprint || "") !== fingerprint) {
        res.status(409).json({
          ok: false,
          error: "Idempotency key reuse does not match the original request."
        });
        return;
      }

      if (existing.response && typeof existing.response === "object") {
        res.setHeader("x-idempotent-replay", "true");
        res.status(Math.max(200, Number(existing.response.statusCode) || 200));
        res.json(existing.response.body);
        return;
      }
    }

    const originalJson = res.json.bind(res);
    res.json = (body) => {
      const statusCode = Math.max(100, Number(res.statusCode) || 200);
      if (statusCode < 500) {
        void writeIdempotencyRecord(
          scope,
          key,
          {
            fingerprint,
            response: {
              statusCode,
              body
            },
            createdAt: Date.now()
          },
          ttlMs
        );
      }
      return originalJson(body);
    };

    req.idempotency = {
      scope,
      key,
      fingerprint
    };

    if (typeof req.logSecurity === "function") {
      req.logSecurity("idempotency_key_attached", {
        scope,
        keyHash: toHash(key)
      }, "debug");
    } else {
      logSecurityEvent("idempotency_key_attached", {
        scope,
        keyHash: toHash(key)
      }, "debug");
    }

    next();
  };
}

module.exports = {
  createIdempotencyMiddleware
};
