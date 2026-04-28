"use strict";

const crypto = require("crypto");

function normalizeLevel(level) {
  const safe = String(level || "info").trim().toLowerCase();
  if (["error", "warn", "info", "debug"].includes(safe)) {
    return safe;
  }
  return "info";
}

function logSecurityEvent(event, fields = {}, level = "info") {
  const safeLevel = normalizeLevel(level);
  const payload = {
    scope: "security",
    level: safeLevel,
    event: String(event || "unknown").trim() || "unknown",
    timestamp: new Date().toISOString(),
    ...fields
  };

  const line = JSON.stringify(payload);
  const writer = typeof console[safeLevel] === "function" ? console[safeLevel] : console.log;
  writer(line);
}

function attachRequestContext(req, res, next) {
  const existing = String(req.headers["x-request-id"] || "").trim();
  const requestId = existing || crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader("x-request-id", requestId);
  req.logSecurity = (event, fields = {}, level = "info") => {
    logSecurityEvent(
      event,
      {
        requestId,
        method: String(req.method || "").trim().toUpperCase(),
        path: String(req.originalUrl || req.url || "").trim(),
        ip: String(req.ip || req.socket?.remoteAddress || "").trim(),
        userEmail: String(req.user?.email || "").trim().toLowerCase(),
        ...fields
      },
      level
    );
  };
  next();
}

module.exports = {
  attachRequestContext,
  logSecurityEvent
};
