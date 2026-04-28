"use strict";

const rateLimit = require("express-rate-limit");
const {
  InMemoryTtlStore
} = require("./in_memory_ttl_store");
const {
  logSecurityEvent
} = require("./logger");
const {
  normalizeEmail
} = require("./auth");

const perUserCounterStore = new InMemoryTtlStore({
  maxEntries: 20000,
  sweepIntervalMs: 60000
});
const perUserSpikeStore = new InMemoryTtlStore({
  maxEntries: 10000,
  sweepIntervalMs: 60000
});

function defaultUserKeyResolver(req) {
  return normalizeEmail(
    req.user?.email ||
      req.body?.email ||
      req.body?.userId ||
      req.body?.user_id ||
      req.params?.email ||
      req.params?.userId ||
      req.params?.user_id ||
      req.query?.email ||
      req.query?.userId ||
      req.query?.user_id
  );
}

function createGlobalIpRateLimiter() {
  return rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => {
      const path = String(req.path || "").trim();
      return path === "/health" || path === "/health.json" || path === "/webhook" || path === "/webhooks" || path === "/stripe/webhook";
    },
    handler: (req, res) => {
      if (typeof req.logSecurity === "function") {
        req.logSecurity("rate_limit_ip_blocked", {
          limit: 100,
          windowMs: 60000
        }, "warn");
      } else {
        logSecurityEvent("rate_limit_ip_blocked", {
          ip: String(req.ip || req.socket?.remoteAddress || "").trim(),
          path: String(req.originalUrl || req.url || "").trim(),
          method: String(req.method || "").trim().toUpperCase(),
          limit: 100,
          windowMs: 60000
        }, "warn");
      }

      res.status(429).json({
        ok: false,
        error: "Too many requests. Please slow down."
      });
    }
  });
}

function createUserRateLimiter(options = {}) {
  const scope = String(options.scope || "user").trim().toLowerCase() || "user";
  const windowMs = Math.max(1000, Number(options.windowMs) || 60000);
  const max = Math.max(1, Number(options.max) || 30);
  const highUsageThreshold = Math.max(1, Math.min(max, Number(options.highUsageThreshold) || Math.ceil(max * 0.8)));
  const message = String(options.message || "Too many requests. Please slow down.").trim() || "Too many requests. Please slow down.";
  const keyResolver = typeof options.keyResolver === "function" ? options.keyResolver : defaultUserKeyResolver;

  return (req, res, next) => {
    const userKey = String(keyResolver(req) || "").trim().toLowerCase();
    if (!userKey) {
      next();
      return;
    }

    const bucket = Math.floor(Date.now() / windowMs);
    const counterKey = `${scope}:${userKey}:${bucket}`;
    const count = perUserCounterStore.increment(counterKey, windowMs + 1000, 1);

    if (count >= highUsageThreshold) {
      const spikeKey = `spike:${counterKey}`;
      const marker = perUserSpikeStore.remember(spikeKey, true, windowMs + 1000);
      if (marker.stored) {
        const logFields = {
          scope,
          userEmail: userKey,
          count,
          max,
          windowMs
        };
        if (typeof req.logSecurity === "function") {
          req.logSecurity("high_usage_spike", logFields, count > max ? "warn" : "info");
        } else {
          logSecurityEvent("high_usage_spike", logFields, count > max ? "warn" : "info");
        }
      }
    }

    if (count > max) {
      if (typeof req.logSecurity === "function") {
        req.logSecurity("rate_limit_user_blocked", {
          scope,
          userEmail: userKey,
          count,
          max,
          windowMs
        }, "warn");
      } else {
        logSecurityEvent("rate_limit_user_blocked", {
          scope,
          userEmail: userKey,
          count,
          max,
          windowMs
        }, "warn");
      }

      res.status(429).json({
        ok: false,
        error: message
      });
      return;
    }

    next();
  };
}

module.exports = {
  createGlobalIpRateLimiter,
  createUserRateLimiter,
  defaultUserKeyResolver
};
