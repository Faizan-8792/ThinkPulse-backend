"use strict";

const express = require("express");

const {
  isConfigured: isSupabaseConfigured,
  upsertUserRegistryRecord,
  listKnownUsersFromPayments
} = require("../payments/supabase_store");

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

module.exports = {
  usersRouter: router
};
