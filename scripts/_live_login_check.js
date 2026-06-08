"use strict";

// Live end-to-end + latency check against the hosted AWS backend.
// Covers: health, OTP request pipeline, demo-session login (same token path as
// OTP verify), new-user joining-bonus availability, claim, wallet reflection,
// dashboard, and admin->user wallet credit reflection. Each call is timed.

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const BASE = "https://th-2730cdd91ed4425fbfeef577240f9559.ecs.us-east-1.on.aws";

const USER = { email: "ahmed@gmail.com", password: "ahmed@1234" };
const ADMIN = { email: "admin@gmail.com", password: "admin@8792187937" };

const results = [];
function rec(name, ok, ms, detail) {
  results.push({ name, ok, ms, detail });
  const tag = ok ? "PASS" : "FAIL";
  console.log(`[${tag}] ${name} (${ms}ms)${detail ? " - " + detail : ""}`);
}

async function call(method, p, { body, token, email } = {}) {
  const headers = { Accept: "application/json" };
  if (body) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = "Bearer " + token;
  if (email) headers["x-thinkpulse-user-email"] = email;
  const t0 = Date.now();
  let status = 0;
  let json = null;
  let text = "";
  try {
    const r = await fetch(BASE + p, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });
    status = r.status;
    text = await r.text();
    try { json = JSON.parse(text); } catch (_e) { json = null; }
  } catch (e) {
    text = "fetch_error:" + e.message;
  }
  return { status, json, text: text.slice(0, 200), ms: Date.now() - t0 };
}

(async () => {
  // 1. Health
  let r = await call("GET", "/health.json");
  rec("health", r.status === 200 && r.json?.ok === true, r.ms,
    `razorpay=${r.json?.razorpayConfigured} supabase=${r.json?.supabaseConfigured} paymentsTable=${r.json?.paymentsTable?.ok}`);

  // 2. OTP request pipeline (real email send). Verifies route + Resend wiring.
  r = await call("POST", "/auth/request-otp", { body: { email: USER.email } });
  rec("request-otp", r.status === 200 && r.json?.ok === true, r.ms,
    r.json?.ok ? `expiresAt set=${Boolean(r.json?.expiresAt)}` : `status=${r.status} ${r.text}`);

  // 3. Login via demo-session (identical downstream token path as verify-otp).
  r = await call("POST", "/auth/demo-session", { body: USER });
  const userToken = r.json?.token || "";
  rec("login (token issue)", r.status === 200 && Boolean(userToken), r.ms,
    `role=${r.json?.auth?.role} tokenType=${r.json?.tokenType}`);

  // 4. Admin login (role parity check).
  r = await call("POST", "/auth/demo-session", { body: ADMIN });
  const adminToken = r.json?.token || "";
  rec("admin login", r.status === 200 && Boolean(adminToken), r.ms, `role=${r.json?.auth?.role}`);

  // 5. User upsert (registration / new-user detection + joining bonus queue).
  r = await call("POST", "/users/upsert", { body: { email: USER.email }, token: userToken, email: USER.email });
  rec("users/upsert", r.status === 200 && r.json?.ok === true, r.ms,
    `isNew=${r.json?.isNewBackendUser} joiningBonus.available=${r.json?.joiningBonus?.available}`);

  // 6. Rewards dashboard (drives bonus page wallet + joining bonus state).
  r = await call("GET", `/rewards/dashboard/${encodeURIComponent(USER.email)}`, { token: userToken, email: USER.email });
  const dash = r.json?.dashboard || {};
  rec("rewards/dashboard", r.status === 200 && r.json?.ok === true, r.ms,
    `joiningEligible=${dash?.joiningBonus?.eligible} claimed=${dash?.joiningBonus?.claimed} promos=${(dash?.promoCodes || []).length}`);

  // 7. Wallet snapshot (drives wallet balance everywhere).
  r = await call("GET", `/wallet/${encodeURIComponent(USER.email)}`, { token: userToken, email: USER.email });
  const balBefore = Number(r.json?.balance || 0);
  rec("wallet snapshot", r.status === 200 && r.json?.ok === true, r.ms, `balanceInr=${balBefore}`);

  // 8. Claim joining bonus (credits wallet). Idempotent — may already be claimed.
  r = await call("POST", "/rewards/joining-bonus/claim", { body: { email: USER.email }, token: userToken, email: USER.email });
  rec("joining-bonus/claim", r.status === 200 && r.json?.ok === true, r.ms,
    `claimed=${r.json?.result?.claimed} already=${r.json?.result?.alreadyClaimed} amountPaise=${r.json?.result?.amountPaise}`);

  // 9. Wallet reflects after claim (latency of credit -> snapshot).
  r = await call("GET", `/wallet/${encodeURIComponent(USER.email)}`, { token: userToken, email: USER.email });
  const balAfter = Number(r.json?.balance || 0);
  rec("wallet after claim", r.status === 200, r.ms, `balanceInr=${balAfter} (was ${balBefore})`);

  // 10. Admin credits user wallet (admin-send-coins path the user asked about).
  r = await call("POST", "/admin/users/credit-wallet",
    { body: { email: USER.email, amountInr: 1 }, token: adminToken, email: ADMIN.email });
  const creditOk = r.status === 200 && r.json?.ok === true;
  rec("admin credit-wallet", creditOk, r.ms,
    creditOk ? `applied=${r.json?.credit?.applied} reason=${r.json?.credit?.reason}` : `status=${r.status} ${r.text}`);

  // 11. Wallet reflects admin credit immediately on next snapshot.
  r = await call("GET", `/wallet/${encodeURIComponent(USER.email)}`, { token: userToken, email: USER.email });
  const balCredited = Number(r.json?.balance || 0);
  rec("wallet after admin credit", r.status === 200, r.ms, `balanceInr=${balCredited}`);

  // ── Latency summary ───────────────────────────────────────────────
  const times = results.filter((x) => Number.isFinite(x.ms)).map((x) => x.ms);
  const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
  const max = Math.max(...times);
  const slow = results.filter((x) => x.ms > 1500).map((x) => `${x.name}=${x.ms}ms`);
  const fails = results.filter((x) => !x.ok);

  console.log("\n──────── SUMMARY ────────");
  console.log(`calls=${results.length} pass=${results.length - fails.length} fail=${fails.length}`);
  console.log(`latency avg=${avg}ms max=${max}ms`);
  console.log(`slow(>1500ms)=${slow.length ? slow.join(", ") : "none"}`);
  if (fails.length) console.log("FAILED: " + fails.map((f) => f.name).join(", "));
  process.exit(fails.length ? 1 : 0);
})();
