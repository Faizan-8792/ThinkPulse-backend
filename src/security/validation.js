"use strict";

const { z, ZodError } = require("zod");

function formatIssues(error) {
  if (!(error instanceof ZodError)) {
    return [];
  }

  return error.issues.map((issue) => ({
    path: Array.isArray(issue.path) ? issue.path.join(".") : "",
    message: String(issue.message || "Invalid value.").trim() || "Invalid value."
  }));
}

function validateRequest(schemas = {}) {
  return (req, res, next) => {
    try {
      if (schemas.params) {
        req.params = schemas.params.parse(req.params || {});
      }
      if (schemas.query) {
        req.query = schemas.query.parse(req.query || {});
      }
      if (schemas.body) {
        req.body = schemas.body.parse(req.body || {});
      }
      next();
    } catch (error) {
      const issues = formatIssues(error);
      res.status(400).json({
        ok: false,
        error: issues[0]?.message || "Invalid request payload.",
        issues
      });
    }
  };
}

const safeString = (maxLength = 120) => z.string().trim().max(Math.max(1, Number(maxLength) || 120));
const optionalSafeString = (maxLength = 120) =>
  z.preprocess(
    (value) => {
      if (value === null || typeof value === "undefined") {
        return undefined;
      }
      return String(value);
    },
    z.string().trim().max(Math.max(1, Number(maxLength) || 120)).optional()
  );

const emailSchema = z.string().trim().toLowerCase().email().max(180);
const optionalEmailSchema = z.preprocess(
  (value) => {
    const safe = String(value || "").trim().toLowerCase();
    return safe || undefined;
  },
  z.string().email().max(180).optional()
);

module.exports = {
  z,
  validateRequest,
  safeString,
  optionalSafeString,
  emailSchema,
  optionalEmailSchema
};
