#!/usr/bin/env node
"use strict";

/**
 * One-shot utility: create regular (non-admin) users in the backend store.
 *
 * Pushes a user-registry row into the Supabase `payments` table for each
 * account so they are recognised as known backend users with the default
 * "free" plan. Login credentials for these accounts are configured via the
 * DEMO_ACCOUNTS env var (consumed by src/security/demo_session.js).
 *
 * Usage:
 *   node scripts/create_users.js
 */

const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const {
  isConfigured,
  upsertUserRegistryRecord,
  getUserRegistryRecord
} = require("../src/payments/supabase_store");

const USERS = [
  { email: "ahmed@gmail.com" },
  { email: "sristhi@gmail.com" }
];

async function main() {
  if (!isConfigured()) {
    console.error("Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.");
    process.exit(1);
  }

  let failures = 0;
  for (const user of USERS) {
    const email = String(user.email || "").trim().toLowerCase();
    try {
      const stored = await upsertUserRegistryRecord({ email, createdAt: Date.now() });
      const confirm = await getUserRegistryRecord(email);
      console.log(`[ok] ${email} -> registered=${Boolean(stored?.stored)} present=${Boolean(confirm?.found)}`);
    } catch (error) {
      failures += 1;
      console.error(`[fail] ${email} -> ${error?.message || error}`);
    }
  }

  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
