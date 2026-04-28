"use strict";

const express = require("express");

const {
  getRewardDashboard,
  claimJoiningBonus,
  upsertPromoCode,
  setPromoCodeStatus,
  clearAllPromoCodes,
  listPromosForAdmin,
  redeemPromoCode,
  listNotifications,
  markNotificationRead
} = require("../rewards/rewards_store");
const {
  authenticateRequest,
  requireRole,
  requireSelfOrAdmin
} = require("../security/auth");
const {
  createIdempotencyMiddleware
} = require("../security/idempotency");
const {
  createUserRateLimiter
} = require("../security/rate_limit");
const {
  z,
  validateRequest,
  safeString,
  optionalSafeString,
  emailSchema
} = require("../security/validation");

const router = express.Router();

/**
 * Converts unknown value to normalized email-like identifier.
 * @param {unknown} value
 * @returns {string}
 */
function normalizeEmail(value) {
  const safe = String(value || "").trim().toLowerCase().slice(0, 180);
  return safe.includes("@") ? safe : "";
}

/**
 * Sanitizes promo code to stable uppercase key.
 * @param {unknown} value
 * @returns {string}
 */
function sanitizePromoCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "")
    .slice(0, 24);
}

const emailParamsSchema = z.object({
  email: emailSchema
});
const notificationsReadBodySchema = z.object({
  email: emailSchema,
  id: safeString(80)
}).passthrough();
const notificationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional()
}).passthrough();
const claimBonusBodySchema = z.object({
  email: emailSchema.optional(),
  userId: emailSchema.optional(),
  user_id: emailSchema.optional()
}).passthrough();
const redeemPromoBodySchema = z.object({
  email: emailSchema.optional(),
  userId: emailSchema.optional(),
  user_id: emailSchema.optional(),
  code: safeString(24)
}).passthrough();
const promoUpsertBodySchema = z.object({
  code: optionalSafeString(24),
  type: optionalSafeString(40),
  assignedToEmail: emailSchema.optional(),
  valueInr: z.coerce.number().min(0).max(100000).optional(),
  percent: z.coerce.number().min(0).max(100).optional(),
  percentBaseInr: z.coerce.number().min(0).max(100000).optional(),
  maxRewardInr: z.coerce.number().min(0).max(100000).optional(),
  usageLimit: z.coerce.number().int().min(0).max(100000).optional(),
  note: optionalSafeString(240),
  expiresAt: optionalSafeString(80),
  allowSelfUse: z.boolean().optional(),
  active: z.boolean().optional(),
  actorEmail: emailSchema.optional()
}).passthrough();
const promoStatusBodySchema = z.object({
  code: safeString(24),
  active: z.boolean().optional()
}).passthrough();

router.use(authenticateRequest());
router.use("/admin", requireRole("admin"));
router.use("/rewards/dashboard/:email", requireSelfOrAdmin([
  { source: "params", key: "email" }
]));
router.use("/rewards/notifications/:email", requireSelfOrAdmin([
  { source: "params", key: "email" }
]));
router.use("/rewards/notifications/read", requireSelfOrAdmin([
  { source: "body", key: "email" }
]));
router.use("/rewards/joining-bonus/claim", requireSelfOrAdmin([
  { source: "body", key: "email" },
  { source: "body", key: "userId" },
  { source: "body", key: "user_id" }
]));
router.use("/rewards/promo/redeem", requireSelfOrAdmin([
  { source: "body", key: "email" },
  { source: "body", key: "userId" },
  { source: "body", key: "user_id" }
]));
router.use(
  "/rewards/joining-bonus/claim",
  createIdempotencyMiddleware({
    scope: "joining_bonus_claim",
    ttlMs: 10 * 60 * 1000,
    deriveKey: (req) => String(req.user?.email || "").trim().toLowerCase()
  })
);
router.use(
  "/rewards/promo/redeem",
  createUserRateLimiter({
    scope: "promo_redeem",
    windowMs: 60 * 1000,
    max: 5,
    keyResolver: (req) => String(req.user?.email || "").trim().toLowerCase(),
    message: "Too many promo redemption attempts. Please slow down."
  }),
  createIdempotencyMiddleware({
    scope: "promo_redeem",
    ttlMs: 10 * 60 * 1000,
    deriveKey: (req) => {
      const email = String(req.user?.email || "").trim().toLowerCase();
      const code = sanitizePromoCode(req.body?.code);
      return `${email}:${code}`;
    }
  })
);

router.get("/rewards/dashboard/:email", validateRequest({ params: emailParamsSchema }), async (req, res) => {
  const email = normalizeEmail(req.params?.email);
  if (!email) {
    res.status(400).json({
      ok: false,
      error: "Valid email is required."
    });
    return;
  }

  try {
    const dashboard = await getRewardDashboard(email);
    res.json({
      ok: true,
      dashboard
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error?.message || "Unable to load rewards dashboard."
    });
  }
});

router.get("/rewards/notifications/:email", validateRequest({ params: emailParamsSchema, query: notificationsQuerySchema }), async (req, res) => {
  const email = normalizeEmail(req.params?.email);
  if (!email) {
    res.status(400).json({
      ok: false,
      error: "Valid email is required."
    });
    return;
  }

  try {
    const notifications = await listNotifications(email, Number(req.query?.limit) || 30);
    res.json({
      ok: true,
      notifications
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error?.message || "Unable to load notifications."
    });
  }
});

router.post("/rewards/notifications/read", validateRequest({ body: notificationsReadBodySchema }), async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const id = String(req.body?.id || "").trim().slice(0, 80);
  if (!email || !id) {
    res.status(400).json({
      ok: false,
      error: "Valid email and notification id are required."
    });
    return;
  }

  try {
    const notification = await markNotificationRead(email, id);
    res.json({
      ok: true,
      notification
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error?.message || "Unable to mark notification as read."
    });
  }
});

router.post("/rewards/joining-bonus/claim", validateRequest({ body: claimBonusBodySchema }), async (req, res) => {
  const email = normalizeEmail(req.body?.email || req.body?.userId || req.body?.user_id);
  if (!email) {
    res.status(400).json({
      ok: false,
      error: "Valid email is required."
    });
    return;
  }

  try {
    const result = await claimJoiningBonus(email);
    const dashboard = await getRewardDashboard(email);
    res.json({
      ok: true,
      result,
      dashboard
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error?.message || "Unable to claim joining bonus."
    });
  }
});

router.post("/rewards/promo/redeem", validateRequest({ body: redeemPromoBodySchema }), async (req, res) => {
  const email = normalizeEmail(req.body?.email || req.body?.userId || req.body?.user_id);
  const code = sanitizePromoCode(req.body?.code);
  if (!email) {
    res.status(400).json({
      ok: false,
      error: "Valid email is required."
    });
    return;
  }
  if (!code) {
    res.status(400).json({
      ok: false,
      error: "Valid promo code is required."
    });
    return;
  }

  try {
    const result = await redeemPromoCode(email, code);
    const dashboard = await getRewardDashboard(email);
    res.json({
      ok: true,
      result,
      dashboard
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error?.message || "Unable to redeem promo code."
    });
  }
});

router.get("/admin/rewards/promos", async (_req, res) => {
  try {
    const promos = await listPromosForAdmin();
    res.json({
      ok: true,
      promos
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error?.message || "Unable to load promo records."
    });
  }
});

router.post("/admin/rewards/promos/upsert", validateRequest({ body: promoUpsertBodySchema }), async (req, res) => {
  try {
    const promo = await upsertPromoCode(
      {
        code: req.body?.code,
        type: req.body?.type,
        assignedToEmail: req.body?.assignedToEmail,
        valueInr: req.body?.valueInr,
        percent: req.body?.percent,
        percentBaseInr: req.body?.percentBaseInr,
        maxRewardInr: req.body?.maxRewardInr,
        usageLimit: req.body?.usageLimit,
        note: req.body?.note,
        expiresAt: req.body?.expiresAt,
        allowSelfUse: req.body?.allowSelfUse,
        active: req.body?.active !== false
      },
      normalizeEmail(req.user?.email || req.body?.actorEmail)
    );
    const promos = await listPromosForAdmin();
    res.json({
      ok: true,
      promo,
      promos
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error?.message || "Unable to save promo code."
    });
  }
});

router.post("/admin/rewards/promos/set-status", validateRequest({ body: promoStatusBodySchema }), async (req, res) => {
  const code = sanitizePromoCode(req.body?.code);
  if (!code) {
    res.status(400).json({
      ok: false,
      error: "Promo code is required."
    });
    return;
  }

  try {
    const promo = await setPromoCodeStatus(code, req.body?.active !== false);
    const promos = await listPromosForAdmin();
    res.json({
      ok: true,
      promo,
      promos
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error?.message || "Unable to update promo status."
    });
  }
});

router.post("/admin/rewards/promos/clear-all", async (_req, res) => {
  try {
    const result = await clearAllPromoCodes();
    const promos = await listPromosForAdmin();
    res.json({
      ok: true,
      result,
      promos
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error?.message || "Unable to clear promo codes."
    });
  }
});

module.exports = {
  rewardsRouter: router
};
