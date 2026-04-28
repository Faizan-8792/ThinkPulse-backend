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

const replayStore = new InMemoryTtlStore({
  maxEntries: 12000,
  sweepIntervalMs: 60000
});

function toHash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

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

function buildReplayStorageKey(provider, replayKey) {
  return `webhook:${String(provider || "generic").trim().toLowerCase()}:${toHash(replayKey)}`;
}

async function hasSeenReplayKey(provider, replayKey) {
  const storageKey = buildReplayStorageKey(provider, replayKey);
  const cached = replayStore.get(storageKey);
  if (cached && Number(cached.expiresAt || 0) > Date.now()) {
    return true;
  }

  if (!isSupabaseConfigured()) {
    return false;
  }

  try {
    const stored = await getGlobalJsonConfig(storageKey);
    const value = stored?.found && stored.value && typeof stored.value === "object" ? stored.value : null;
    if (!value || Number(value.expiresAt || 0) <= Date.now()) {
      return false;
    }
    replayStore.set(storageKey, value, Math.max(1000, Number(value.expiresAt || 0) - Date.now()));
    return true;
  } catch (_error) {
    return false;
  }
}

async function rememberReplayKey(provider, replayKey, ttlMs) {
  const storageKey = buildReplayStorageKey(provider, replayKey);
  const safeTtlMs = Math.max(60 * 1000, Number(ttlMs) || 24 * 60 * 60 * 1000);
  const value = {
    replayKeyHash: toHash(replayKey),
    seenAt: Date.now(),
    expiresAt: Date.now() + safeTtlMs
  };

  replayStore.set(storageKey, value, safeTtlMs);
  if (!isSupabaseConfigured()) {
    return value;
  }

  try {
    await upsertGlobalJsonConfig(storageKey, value);
  } catch (_error) {
  }

  return value;
}

async function enforceWebhookReplayProtection(options = {}) {
  const provider = String(options.provider || "generic").trim().toLowerCase() || "generic";
  const replayKey = String(options.replayKey || "").trim();
  const occurredAtMs = toEpochMs(options.occurredAtMs || options.occurredAt || 0);
  const maxAgeMs = Math.max(60 * 1000, Number(options.maxAgeMs) || 15 * 60 * 1000);
  const ttlMs = Math.max(maxAgeMs, Number(options.ttlMs) || 24 * 60 * 60 * 1000);

  if (!replayKey) {
    return {
      ok: true,
      reason: "missing_replay_key"
    };
  }

  if (occurredAtMs > 0 && Math.abs(Date.now() - occurredAtMs) > maxAgeMs) {
    return {
      ok: false,
      reason: "stale",
      statusCode: 409,
      error: "Webhook timestamp is outside the allowed freshness window."
    };
  }

  const seen = await hasSeenReplayKey(provider, replayKey);
  if (seen) {
    return {
      ok: false,
      reason: "duplicate",
      statusCode: 409,
      error: "Duplicate webhook rejected."
    };
  }

  await rememberReplayKey(provider, replayKey, ttlMs);
  return {
    ok: true,
    reason: "accepted"
  };
}

module.exports = {
  enforceWebhookReplayProtection,
  toEpochMs
};
