"use strict";

const express = require("express");

const {
  isConfigured: isSupabaseConfigured,
  setUserPlanState,
  getUserPlanState,
  upsertUserRegistryRecord,
  listKnownUsersFromPayments
} = require("../payments/supabase_store");
const {
  creditWallet,
  getWalletSnapshot
} = require("../payments/wallet_store");
const {
  recordAdminWalletCredit
} = require("../rewards/rewards_store");

const router = express.Router();

/**
 * Converts unknown value to normalized email-like identifier.
 * @param {unknown} value
 * @returns {string}
 */
function normalizeEmail(value) {
  const safe = String(value || "").trim().toLowerCase().slice(0, 180);
  if (!safe.includes("@")) {
    return "";
  }
  return safe;
}

/**
 * Normalizes plan input.
 * @param {unknown} value
 * @returns {"free"|"basic"|"premium"|"admin"|""}
 */
function normalizePlan(value) {
  const safe = String(value || "").trim().toLowerCase();
  if (safe === "free" || safe === "basic" || safe === "premium" || safe === "admin") {
    return safe;
  }
  return "";
}

/**
 * Normalizes INR amount.
 * @param {unknown} value
 * @returns {number}
 */
function normalizeInrAmount(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.round(numeric * 100) / 100;
}

router.post("/users/upsert", async (req, res) => {
  if (!isSupabaseConfigured()) {
    res.status(503).json({
      ok: false,
      error: "Supabase is not configured on the server."
    });
    return;
  }

  const email = normalizeEmail(req.body?.email || req.body?.userId || req.body?.user_id);
  if (!email) {
    res.status(400).json({
      ok: false,
      error: "Valid email is required."
    });
    return;
  }

  try {
    const stored = await upsertUserRegistryRecord({
      email,
      createdAt: Date.now()
    });

    res.json({
      ok: true,
      stored
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error?.message || "Unable to upsert backend user registry."
    });
  }
});

router.get("/admin/users", async (_req, res) => {
  if (!isSupabaseConfigured()) {
    res.status(503).json({
      ok: false,
      error: "Supabase is not configured on the server."
    });
    return;
  }

  try {
    const listed = await listKnownUsersFromPayments();
    res.json({
      ok: true,
      users: Array.isArray(listed?.users) ? listed.users : [],
      count: Array.isArray(listed?.users) ? listed.users.length : 0
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error?.message || "Unable to list backend users."
    });
  }
});

router.post("/admin/users/set-plan", async (req, res) => {
  if (!isSupabaseConfigured()) {
    res.status(503).json({
      ok: false,
      error: "Supabase is not configured on the server."
    });
    return;
  }

  const email = normalizeEmail(req.body?.email || req.body?.userId || req.body?.user_id);
  const plan = normalizePlan(req.body?.plan);
  if (!email) {
    res.status(400).json({
      ok: false,
      error: "Valid email is required."
    });
    return;
  }
  if (!plan) {
    res.status(400).json({
      ok: false,
      error: "Valid plan is required (free/basic/premium/admin)."
    });
    return;
  }

  try {
    await upsertUserRegistryRecord({
      email,
      createdAt: Date.now()
    });

    const update = await setUserPlanState({
      userId: email,
      plan
    });

    const planState = await getUserPlanState({ userId: email });
    res.json({
      ok: true,
      email,
      requestedPlan: plan,
      persistedPlan: planState?.found ? planState.plan : "",
      update,
      planState
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error?.message || "Unable to persist user plan override."
    });
  }
});

router.get("/users/plan/:email", async (req, res) => {
  if (!isSupabaseConfigured()) {
    res.status(503).json({
      ok: false,
      error: "Supabase is not configured on the server."
    });
    return;
  }

  const email = normalizeEmail(req.params?.email);
  if (!email) {
    res.status(400).json({
      ok: false,
      error: "Valid email is required."
    });
    return;
  }

  try {
    const planState = await getUserPlanState({ userId: email });
    res.json({
      ok: true,
      email,
      plan: planState?.found ? String(planState.plan || "") : "",
      found: Boolean(planState?.found),
      source: planState?.table || ""
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error?.message || "Unable to fetch user plan state."
    });
  }
});

router.post("/admin/users/credit-wallet", async (req, res) => {
  const email = normalizeEmail(req.body?.email || req.body?.userId || req.body?.user_id);
  const amountInr = normalizeInrAmount(req.body?.amountInr || req.body?.amount);
  const note = String(req.body?.note || "admin_wallet_credit").trim().slice(0, 80) || "admin_wallet_credit";
  const actorEmail = normalizeEmail(req.body?.actorEmail);

  if (!email) {
    res.status(400).json({
      ok: false,
      error: "Valid email is required."
    });
    return;
  }

  if (!Number.isFinite(amountInr) || amountInr <= 0) {
    res.status(400).json({
      ok: false,
      error: "Valid amountInr is required."
    });
    return;
  }

  try {
    const paymentId = `admin_credit:${email}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    const credit = await creditWallet({
      userId: email,
      amountInr,
      paymentId,
      source: note
    });

    if (credit?.applied) {
      await recordAdminWalletCredit({
        email,
        amountInr,
        note,
        actorEmail
      }).catch(() => undefined);
    }

    res.json({
      ok: true,
      email,
      amountInr,
      credit,
      wallet: getWalletSnapshot(email)
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error?.message || "Unable to apply admin wallet credit."
    });
  }
});

module.exports = {
  usersRouter: router
};
