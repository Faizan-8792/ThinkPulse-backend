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

router.get("/rewards/dashboard/:email", async (req, res) => {
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

router.get("/rewards/notifications/:email", async (req, res) => {
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

router.post("/rewards/notifications/read", async (req, res) => {
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

router.post("/rewards/joining-bonus/claim", async (req, res) => {
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

router.post("/rewards/promo/redeem", async (req, res) => {
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

router.post("/admin/rewards/promos/upsert", async (req, res) => {
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
      normalizeEmail(req.body?.actorEmail)
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

router.post("/admin/rewards/promos/set-status", async (req, res) => {
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
