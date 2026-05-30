#!/usr/bin/env node
"use strict";

/**
 * One-shot utility: delete every non-admin user from the backend stores.
 *
 * Designed to be run against a deployed backend by an admin who already
 * has a valid bearer token. The route /admin/users/delete-all-non-admins
 * is protected by requireRole("admin"); this script just packages the
 * call so admins can run it from the CLI without crafting curl commands.
 *
 * Usage:
 *   node scripts/delete_all_non_admins.js \
 *     --baseUrl=https://your-backend.example.com \
 *     --authToken=<admin-bearer-token>
 *
 * Optional flags:
 *   --dryRun=true   Lists who would be deleted but does not delete.
 *   --userEmail=... Sets x-thinkpulse-user-email header (helpful for demo tokens).
 */

const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

function parseArgs(argv) {
  const out = {};
  for (const piece of argv) {
    const value = String(piece || "").trim();
    if (!value.startsWith("--")) continue;
    const withoutPrefix = value.slice(2);
    const eqIndex = withoutPrefix.indexOf("=");
    if (eqIndex < 0) {
      out[withoutPrefix] = true;
      continue;
    }
    out[withoutPrefix.slice(0, eqIndex).trim()] = withoutPrefix.slice(eqIndex + 1).trim();
  }
  return out;
}

function asBool(value) {
  if (value === true) return true;
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = String(args.baseUrl || process.env.CHECK_BASE_URL || "").trim().replace(/\/+$/, "");
  const authToken = String(args.authToken || process.env.CHECK_AUTH_TOKEN || "").trim();
  const userEmail = String(args.userEmail || args.authEmail || "").trim().toLowerCase();
  const dryRun = asBool(args.dryRun);

  if (!baseUrl) {
    console.error("Missing --baseUrl");
    process.exit(1);
  }
  if (!authToken) {
    console.error("Missing --authToken (admin bearer token)");
    process.exit(1);
  }

  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${authToken}`
  };
  if (userEmail) {
    headers["x-thinkpulse-user-email"] = userEmail;
  }

  if (dryRun) {
    console.log(`[dry-run] Listing users at ${baseUrl}/admin/users`);
    const list = await fetch(new URL("/admin/users", `${baseUrl}/`).toString(), { headers });
    const text = await list.text();
    console.log(`status=${list.status}`);
    console.log(text);
    return;
  }

  const url = new URL("/admin/users/delete-all-non-admins", `${baseUrl}/`).toString();
  console.log(`POST ${url}`);
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ confirm: true })
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch (_error) {
    payload = null;
  }

  console.log(`status=${response.status}`);
  if (payload) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(text);
  }

  process.exitCode = response.ok && payload?.ok ? 0 : 1;
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
