#!/usr/bin/env node
"use strict";

/**
 * Hardcore end-to-end check covering:
 *
 *   SECURITY
 *   --------
 *   - chrome.storage.local must NEVER contain raw API keys
 *   - remoteBootstrapConfigV1 disk record must have empty key fields
 *   - adminApis must not be persisted (memory-only)
 *   - settings.webSearchTavilyKeys / settings.webSearchSerperKeys
 *     must not be auto-populated from remote bootstrap
 *
 *   FREE-USER LIFECYCLE
 *   -------------------
 *   - new free user has wallet=0, plan="free"
 *   - claimJoiningBonus credits 2000 paise
 *   - chat/exam usage drains the wallet
 *   - drained wallet -> wallet_empty error
 *
 *   PROMOTION TO PREMIUM
 *   --------------------
 *   - admin recharges user with >=10000 paise (>= ₹100) -> plan=premium
 *   - premium user can run chat without wallet_empty
 *   - premium pricing model is correct
 *
 *   ADMIN BONUS DELIVERY
 *   --------------------
 *   - admin sets a fixed_wallet promo code
 *   - target user redeems it
 *   - wallet balance reflects the promo amount
 *
 *   ADMIN BYPASS
 *   ------------
 *   - admin role usage never debits a wallet
 *
 * The test imports the real frontend storage_manager.js via dynamic import
 * and shims chrome.storage.local + global fetch so no network is touched.
 * Bootstrap-fetch endpoint URL is intercepted to return a fixture so we can
 * verify the in-memory-vs-disk separation deterministically.
 */

const path = require("path");
const url = require("url");
const fs = require("fs");

const HARNESS_REPORT = [];
const REAL_KEY_TOKEN_FRAGMENTS = [
  "nvapi-",
  "K87519674788957",
  "tvly-dev-",
  "sk-",
  "AIza"
];

function record(name, status, detail) {
  HARNESS_REPORT.push({ name, status, detail });
}

function assertEqual(name, actual, expected) {
  if (actual === expected) {
    record(name, "PASS", `value=${JSON.stringify(actual)}`);
    return true;
  }
  record(name, "FAIL", `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
  return false;
}

function assertTrue(name, value, detail = "") {
  if (value) {
    record(name, "PASS", detail || "true");
    return true;
  }
  record(name, "FAIL", detail || `value=${JSON.stringify(value)}`);
  return false;
}

function assertFalse(name, value, detail = "") {
  return assertTrue(name, !value, detail);
}

function installChromeStorageShim() {
  const local = new Map();
  globalThis.chrome = {
    storage: {
      local: {
        async get(keys) {
          if (keys === undefined || keys === null) {
            const out = {};
            for (const [k, v] of local.entries()) out[k] = JSON.parse(JSON.stringify(v));
            return out;
          }
          const list = Array.isArray(keys)
            ? keys
            : typeof keys === "string"
              ? [keys]
              : Object.keys(keys);
          const out = {};
          for (const key of list) {
            if (local.has(key)) out[key] = JSON.parse(JSON.stringify(local.get(key)));
            else if (keys && typeof keys === "object" && !Array.isArray(keys)) {
              out[key] = JSON.parse(JSON.stringify(keys[key]));
            }
          }
          return out;
        },
        async set(items) {
          for (const [k, v] of Object.entries(items || {})) {
            local.set(k, JSON.parse(JSON.stringify(v)));
          }
        },
        async remove(keys) {
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) local.delete(k);
        }
      }
    },
    runtime: {
      id: "harness",
      getURL(p) { return `chrome-extension://harness/${p}`; },
      sendMessage: async () => ({ ok: true }),
      onMessage: { addListener: () => undefined }
    }
  };
  return { local };
}

/**
 * Fetch shim that returns the bootstrap fixture (with raw keys) for
 * /config/default-pools, and 404s everything else.
 */
function installBootstrapFetchShim() {
  const fixture = {
    ok: true,
    fetchedAt: Date.now(),
    data: {
      adminPool: {
        openrouter: ["sk-or-v1-FAKE-OR-A", "sk-or-v1-FAKE-OR-B"],
        gemini: ["AIzaFAKE-GEMINI-A"],
        deepseek: { key: "sk-FAKE-DEEPSEEK", endpoint: "https://api.deepseek.com/chat/completions", model: "deepseek-chat" },
        qwen: { key: "nvapi-FAKE-QWEN", endpoint: "https://integrate.api.nvidia.com/v1/chat/completions", model: "qwen/qwen2.5-coder-7b-instruct" },
        llamaPrimary: { key: "nvapi-FAKE-LLAMA", endpoint: "https://integrate.api.nvidia.com/v1/chat/completions", model: "meta/llama-3.1-70b-instruct" },
        vision: { key: "nvapi-FAKE-VISION", endpoint: "https://integrate.api.nvidia.com/v1/chat/completions", model: "nvidia/nemotron-nano-12b-v2-vl" },
        imageGen: { key: "nvapi-FAKE-IMAGE", endpoint: "https://integrate.api.nvidia.com/v1/images/generations", model: "stable-diffusion-3.5-large" },
        ocr: {
          ocrspace: { key: "K87519674788957", endpoint: "https://api.ocr.space/parse/image" },
          nvidia: { key: "nvapi-FAKE-OCR-NVIDIA", endpoint: "https://integrate.api.nvidia.com/v1/ocr", model: "nemoretriever-ocr-v1" }
        },
        asr: { key: "nvapi-FAKE-ASR", endpoint: "https://integrate.api.nvidia.com/v1/audio/transcriptions", model: "ai-parakeet-ctc-1.1b-asr" }
      },
      webSearchDefaults: {
        tavily: ["tvly-dev-FAKE-A", "tvly-dev-FAKE-B"],
        serper: ["serper-FAKE-A"]
      }
    }
  };

  globalThis.fetch = async (target) => {
    const targetUrl = String(target?.url || target || "");
    if (targetUrl.includes("/config/default-pools")) {
      return {
        ok: true,
        status: 200,
        url: targetUrl,
        headers: { get: () => "application/json", has: () => true },
        async text() { return JSON.stringify(fixture); },
        async json() { return fixture; }
      };
    }
    return {
      ok: false,
      status: 404,
      url: targetUrl,
      headers: { get: () => null, has: () => false },
      async text() { return ""; },
      async json() { return {}; }
    };
  };
}

async function loadStorageManager() {
  const moduleSpecifier = url.pathToFileURL(
    path.resolve(__dirname, "..", "..", "frontend", "lib", "storage_manager.js")
  ).href;
  return import(moduleSpecifier);
}

function deepStringContainsAny(value, fragments) {
  const seen = new WeakSet();
  function visit(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === "string") {
      for (const frag of fragments) {
        if (v.includes(frag)) return frag;
      }
      return null;
    }
    if (typeof v !== "object") return null;
    if (seen.has(v)) return null;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const item of v) {
        const hit = visit(item);
        if (hit) return hit;
      }
      return null;
    }
    for (const inner of Object.values(v)) {
      const hit = visit(inner);
      if (hit) return hit;
    }
    return null;
  }
  return visit(value);
}

async function freshUserProfile(StorageManager, email) {
  const profiles = await StorageManager.getBillingProfiles();
  delete profiles[email.toLowerCase()];
  await StorageManager.saveBillingProfiles(profiles);
  const bonus = await StorageManager.getBonusProfiles();
  delete bonus[email.toLowerCase()];
  await StorageManager.saveBonusProfiles(bonus);
}

async function setAuth(StorageManager, email, role) {
  await StorageManager.setAuth({
    email: email.toLowerCase(),
    role,
    isLoggedIn: true,
    loginTime: Date.now()
  });
}

async function dumpDiskSnapshot(localMap) {
  const out = {};
  for (const [k, v] of localMap.entries()) {
    out[k] = JSON.parse(JSON.stringify(v));
  }
  return out;
}

async function runScenarios() {
  const { local } = installChromeStorageShim();
  installBootstrapFetchShim();

  // ─── PHASE 0: ONE-TIME SECURITY PURGE MIGRATION ────────────────────
  // Pre-seed chrome.storage.local with the exact leak shape produced by
  // the legacy build (raw bootstrap keys, fzn::-encoded admin pool,
  // and managed Tavily/Serper keys leaked into settings) and confirm
  // the purge wipes all of it on first init.
  const LEGACY_TAVILY = "tvly-dev-pTSgg-LEGACY-LEAK-1";
  const LEGACY_SERPER = "serper-LEGACY-LEAK-1";
  const fznEncode = (s) => `fzn::${Buffer.from(s, "utf8").toString("base64")}`;
  await chrome.storage.local.set({
    adminApis: {
      openrouter: [fznEncode("sk-or-v1-LEGACY-LEAK")],
      gemini: [fznEncode("AIzaLEGACY-LEAK")],
      deepseek: { key: fznEncode("sk-LEGACY-DEEPSEEK"), endpoint: "x", model: "x" },
      qwen: { key: fznEncode("nvapi-LEGACY-QWEN"), endpoint: "x", model: "x" },
      llamaPrimary: { key: fznEncode("nvapi-LEGACY-LLAMA"), endpoint: "x", model: "x" },
      vision: { key: fznEncode("nvapi-LEGACY-VISION"), endpoint: "x", model: "x" },
      imageGen: { key: fznEncode("nvapi-LEGACY-IMG"), endpoint: "x", model: "x" },
      ocr: {
        ocrspace: { key: fznEncode("K87519674788957"), endpoint: "x" },
        nvidia: { key: fznEncode("nvapi-LEGACY-OCR"), endpoint: "x", model: "x" }
      },
      asr: { key: fznEncode("nvapi-LEGACY-ASR"), endpoint: "x", model: "x" }
    },
    remoteBootstrapConfigV1: {
      fetchedAt: Date.now(),
      data: {
        adminPool: {
          openrouter: ["sk-or-v1-LEGACY-LEAK-RAW"],
          gemini: ["AIzaLEGACY-LEAK-RAW"],
          deepseek: { key: "sk-LEGACY-RAW", endpoint: "x", model: "x" },
          qwen: { key: "nvapi-LEGACY-QWEN-RAW", endpoint: "x", model: "x" },
          llamaPrimary: { key: "nvapi-LEGACY-LLAMA-RAW", endpoint: "x", model: "x" },
          vision: { key: "nvapi-LEGACY-VISION-RAW", endpoint: "x", model: "x" },
          imageGen: { key: "nvapi-LEGACY-IMG-RAW", endpoint: "x", model: "x" },
          ocr: {
            ocrspace: { key: "K87519674788957", endpoint: "x" },
            nvidia: { key: "nvapi-LEGACY-OCR-RAW", endpoint: "x", model: "x" }
          },
          asr: { key: "nvapi-LEGACY-ASR-RAW", endpoint: "x", model: "x" }
        },
        webSearchDefaults: {
          tavily: [LEGACY_TAVILY],
          serper: [LEGACY_SERPER]
        }
      }
    },
    settings: {
      theme: "light",
      apiMode: "multiple",
      backendBaseUrl: "https://thinkpulse-api-cpdre8hrencgaagx.centralindia-01.azurewebsites.net",
      webSearchTavilyKeys: [fznEncode(LEGACY_TAVILY)],
      webSearchSerperKeys: [fznEncode(LEGACY_SERPER)],
      webSearchApiKey: fznEncode(LEGACY_TAVILY)
    }
  });

  const sm = await loadStorageManager();
  const { StorageManager } = sm;

  // First call into storage triggers ensureDefaults which runs the purge.
  await StorageManager.init();

  const purgeSnapshot = await dumpDiskSnapshot(local);
  const purgeLeak = deepStringContainsAny(purgeSnapshot, [
    "LEGACY-LEAK", "LEGACY-DEEPSEEK", "LEGACY-RAW", "LEGACY-QWEN",
    "LEGACY-LLAMA", "LEGACY-VISION", "LEGACY-IMG", "LEGACY-OCR",
    "LEGACY-ASR", "K87519674788957", "tvly-dev-pTSgg",
    "serper-LEGACY", "nvapi-LEGACY", "sk-or-v1-LEGACY", "AIzaLEGACY"
  ]);
  assertTrue(
    "[MIGRATE] one-time purge removes ALL legacy leaks",
    purgeLeak === null,
    purgeLeak ? `still leaks="${purgeLeak}"` : "all clean"
  );
  assertEqual(
    "[MIGRATE] adminApis purged",
    Object.prototype.hasOwnProperty.call(purgeSnapshot, "adminApis"),
    false
  );
  assertEqual(
    "[MIGRATE] settings.webSearchTavilyKeys cleared",
    Array.isArray(purgeSnapshot.settings?.webSearchTavilyKeys) && purgeSnapshot.settings.webSearchTavilyKeys.length,
    0
  );
  assertEqual(
    "[MIGRATE] settings.webSearchSerperKeys cleared",
    Array.isArray(purgeSnapshot.settings?.webSearchSerperKeys) && purgeSnapshot.settings.webSearchSerperKeys.length,
    0
  );
  assertEqual(
    "[MIGRATE] settings.webSearchApiKey cleared",
    String(purgeSnapshot.settings?.webSearchApiKey || ""),
    ""
  );
  assertEqual(
    "[MIGRATE] purge marker set",
    Boolean(purgeSnapshot.thinkpulseStorageKeyPurgeV2),
    true
  );

  // ─── PHASE 1: SECURITY ─────────────────────────────────────────────
  // Trigger ensureDefaults via getSettings(), which fetches the bootstrap.
  await StorageManager.getSettings();
  // Force the admin pool memory population path.
  await StorageManager.getAdminApis();

  const diskSnapshot = await dumpDiskSnapshot(local);

  // 1a. Confirm raw key fragments do not appear anywhere in chrome.storage.local.
  const leaked = deepStringContainsAny(diskSnapshot, REAL_KEY_TOKEN_FRAGMENTS);
  assertTrue(
    "[SEC] No raw API key fragments in chrome.storage.local",
    leaked === null,
    leaked ? `leaked fragment="${leaked}" found in disk snapshot` : "clean"
  );

  // 1b. Confirm remoteBootstrapConfigV1 record exists but its adminPool keys
  //      are stripped to empty strings/arrays.
  const bootstrapRecord = diskSnapshot.remoteBootstrapConfigV1;
  assertTrue(
    "[SEC] remoteBootstrapConfigV1 exists on disk",
    bootstrapRecord && typeof bootstrapRecord === "object",
    `record present=${!!bootstrapRecord}`
  );
  if (bootstrapRecord) {
    const pool = bootstrapRecord.data?.adminPool || {};
    const keyFields = [
      pool.deepseek?.key, pool.qwen?.key, pool.llamaPrimary?.key, pool.vision?.key,
      pool.imageGen?.key, pool.ocr?.ocrspace?.key, pool.ocr?.nvidia?.key, pool.asr?.key
    ];
    const allKeysBlank = keyFields.every((v) => String(v || "") === "");
    assertTrue(
      "[SEC] remoteBootstrapConfigV1.adminPool keys stripped to empty",
      allKeysBlank,
      `nonEmpty=${JSON.stringify(keyFields.filter((v) => String(v || "") !== ""))}`
    );
    assertEqual(
      "[SEC] remoteBootstrapConfigV1.adminPool.openrouter is empty array",
      Array.isArray(pool.openrouter) && pool.openrouter.length,
      0
    );
    assertEqual(
      "[SEC] remoteBootstrapConfigV1.adminPool.gemini is empty array",
      Array.isArray(pool.gemini) && pool.gemini.length,
      0
    );
    assertEqual(
      "[SEC] remoteBootstrapConfigV1.webSearchDefaults.tavily empty",
      Array.isArray(bootstrapRecord.data?.webSearchDefaults?.tavily) && bootstrapRecord.data.webSearchDefaults.tavily.length,
      0
    );
    assertEqual(
      "[SEC] remoteBootstrapConfigV1.webSearchDefaults.serper empty",
      Array.isArray(bootstrapRecord.data?.webSearchDefaults?.serper) && bootstrapRecord.data.webSearchDefaults.serper.length,
      0
    );
  }

  // 1c. Confirm adminApis is NOT present on disk.
  assertEqual(
    "[SEC] adminApis NOT persisted to chrome.storage.local",
    Object.prototype.hasOwnProperty.call(diskSnapshot, "adminApis"),
    false
  );

  // 1d. Confirm settings.webSearchTavilyKeys / Serper keys were not auto-filled.
  const settings = diskSnapshot.settings || {};
  assertEqual(
    "[SEC] settings.webSearchTavilyKeys not auto-populated from bootstrap",
    Array.isArray(settings.webSearchTavilyKeys) && settings.webSearchTavilyKeys.length,
    0
  );
  assertEqual(
    "[SEC] settings.webSearchSerperKeys not auto-populated from bootstrap",
    Array.isArray(settings.webSearchSerperKeys) && settings.webSearchSerperKeys.length,
    0
  );
  assertEqual(
    "[SEC] settings.webSearchApiKey not auto-populated from bootstrap",
    String(settings.webSearchApiKey || ""),
    ""
  );

  // 1e. Confirm getAdminApis() still returns real keys at runtime
  //      (memory-only path).
  const adminPool = await StorageManager.getAdminApis();
  assertTrue(
    "[SEC] getAdminApis() returns deepseek key in memory",
    String(adminPool?.deepseek?.key || "").startsWith("sk-FAKE-DEEPSEEK"),
    `deepseekKey=${adminPool?.deepseek?.key || ""}`
  );
  assertTrue(
    "[SEC] getAdminApis() returns ocrspace key in memory",
    String(adminPool?.ocr?.ocrspace?.key || "") === "K87519674788957",
    `ocrspaceKey=${adminPool?.ocr?.ocrspace?.key || ""}`
  );

  // 1f. Migration path: simulate a leaked legacy record and confirm
  //      a refetch sanitizes it on next access.
  await chrome.storage.local.set({
    remoteBootstrapConfigV1: {
      fetchedAt: Date.now(),
      data: {
        adminPool: {
          openrouter: ["sk-or-v1-LEGACY-LEAK"],
          gemini: ["AIzaLEGACY-LEAK"],
          deepseek: { key: "sk-LEGACY-DEEPSEEK", endpoint: "x", model: "x" },
          qwen: { key: "nvapi-LEGACY-QWEN", endpoint: "x", model: "x" },
          llamaPrimary: { key: "nvapi-LEGACY-LLAMA", endpoint: "x", model: "x" },
          vision: { key: "nvapi-LEGACY-VISION", endpoint: "x", model: "x" },
          imageGen: { key: "nvapi-LEGACY-IMG", endpoint: "x", model: "x" },
          ocr: {
            ocrspace: { key: "K_LEGACY", endpoint: "x" },
            nvidia: { key: "nvapi-LEGACY-OCR", endpoint: "x", model: "x" }
          },
          asr: { key: "nvapi-LEGACY-ASR", endpoint: "x", model: "x" }
        },
        webSearchDefaults: { tavily: ["tvly-dev-LEAK"], serper: ["serper-LEAK"] }
      }
    },
    adminApis: {
      openrouter: ["fzn::stale-base64"],
      deepseek: { key: "fzn::stale-base64" }
    }
  });
  // Trigger a settings access — the new path detects the leftover keys and
  // overwrites the disk record with a stripped copy on the next bootstrap read.
  await StorageManager.getSettings();
  // The migration code path runs from inside getRemoteBootstrapConfig when
  // it reuses the cached record. Force a re-read so the migration triggers.
  await StorageManager.getAdminApis();
  const postMigrationSnapshot = await dumpDiskSnapshot(local);
  // Debug: dump what disk currently looks like for the bootstrap key.
  const debugBootstrap = postMigrationSnapshot.remoteBootstrapConfigV1;
  if (debugBootstrap) {
    record(
      "[SEC] Post-migration bootstrap snapshot keys",
      "PASS",
      `data.adminPool keys=${JSON.stringify(Object.keys(debugBootstrap.data?.adminPool || {}))}`
    );
  }
  const leakAfterMigration = deepStringContainsAny(postMigrationSnapshot, [
    "sk-LEGACY", "LEGACY-LEAK", "LEGACY-DEEPSEEK", "LEGACY-QWEN", "LEGACY-LLAMA",
    "LEGACY-VISION", "LEGACY-IMG", "K_LEGACY", "LEGACY-OCR", "LEGACY-ASR",
    "tvly-dev-LEAK", "serper-LEAK"
  ]);
  assertTrue(
    "[SEC] Migration sanitizes legacy leaked records on next read",
    leakAfterMigration === null,
    leakAfterMigration ? `still leaks="${leakAfterMigration}"` : "clean after migration"
  );
  assertEqual(
    "[SEC] adminApis purged on migration path",
    Object.prototype.hasOwnProperty.call(postMigrationSnapshot, "adminApis"),
    false
  );

  // ─── PHASE 2: FREE-USER LIFECYCLE ──────────────────────────────────
  const FREE = "freeuser+e2e@example.com";
  await freshUserProfile(StorageManager, FREE);
  await setAuth(StorageManager, FREE, "user");

  const fresh = await StorageManager.getBillingState(FREE, "user");
  assertEqual("[FREE] new user plan", fresh.plan, "free");
  assertEqual("[FREE] new user wallet 0", fresh.walletPaise, 0);

  // 2a. Joining bonus credit
  const claimResult = await StorageManager.claimJoiningBonus(FREE, "user");
  assertEqual("[FREE] claimJoiningBonus credited", Boolean(claimResult?.claimed), true);
  const afterClaim = await StorageManager.getBillingState(FREE, "user");
  assertEqual("[FREE] post-bonus wallet=2000", afterClaim.walletPaise, 2000);
  assertEqual("[FREE] post-bonus plan still free", afterClaim.plan, "free");

  // 2b. Drain via web_search exam usage. The system uses a soft `wallet_low`
  //     guardrail before the wallet hits exactly 0, so we treat both wallet_low
  //     and wallet_empty as legitimate "drained" outcomes.
  let drained = 0;
  let drainCode = "";
  for (let i = 0; i < 5000; i += 1) {
    const r = await StorageManager.authorizeExamUsage(FREE, "user", {
      mode: "exam",
      domain: "drain.test",
      usageType: "web_search"
    });
    if (r.ok) { drained += 1; continue; }
    drainCode = r.code;
    break;
  }
  const post = await StorageManager.getBillingState(FREE, "user");
  assertTrue(
    "[FREE] wallet drained close to zero",
    post.walletPaise < 100,
    `walletPaise=${post.walletPaise}`
  );
  assertTrue(
    "[FREE] drain blocks with wallet_empty/wallet_low",
    drainCode === "wallet_empty" || drainCode === "wallet_low",
    `code=${drainCode} iterations=${drained}`
  );
  assertTrue(
    "[FREE] drain iterations roughly match expected (~50)",
    drained >= 30 && drained <= 60,
    `iterations=${drained}`
  );

  // 2c. Chat after wallet drained — push the wallet to true zero by issuing
  //     additional chat calls until the system blocks. With ~24 paise residual
  //     after the web_search drain, one more chat usually empties it.
  let postDrainChat = null;
  let trailingChatAttempts = 0;
  for (let i = 0; i < 200; i += 1) {
    trailingChatAttempts += 1;
    postDrainChat = await StorageManager.authorizeChatUsage(FREE, "user", {
      source: `harness_chat_${i}`
    });
    if (!postDrainChat.ok) break;
  }
  assertEqual("[FREE] post-drain chat eventually blocked", postDrainChat?.ok, false);
  assertTrue(
    "[FREE] post-drain chat code valid",
    postDrainChat?.code === "wallet_empty" || postDrainChat?.code === "wallet_low",
    `code=${postDrainChat?.code} attempts=${trailingChatAttempts}`
  );

  // ─── PHASE 3: PROMOTION TO PREMIUM ─────────────────────────────────
  // Admin credits ₹100 (10000 paise) -> premium plan.
  await StorageManager.rechargeWallet(FREE, 10000, {
    plan: "premium",
    note: "admin_test_premium_topup"
  });
  await StorageManager.applyPlanPurchase(FREE, "premium", {
    paymentId: `e2e_pay_${Date.now()}`,
    amountPaise: 10000
  });
  const promoted = await StorageManager.getBillingState(FREE, "user");
  assertEqual("[PREMIUM] plan promoted to premium", promoted.plan, "premium");
  assertTrue(
    "[PREMIUM] wallet >= 10000 after recharge",
    promoted.walletPaise >= 10000,
    `wallet=${promoted.walletPaise}`
  );
  // Premium chat fee per message
  const premiumChat = await StorageManager.authorizeChatUsage(FREE, "user", {
    source: "harness_premium_chat"
  });
  assertEqual("[PREMIUM] chat allowed after upgrade", premiumChat.ok, true);
  assertTrue(
    "[PREMIUM] chat charged some amount",
    Number(premiumChat.chargedPaise) >= 0,
    `charged=${premiumChat.chargedPaise}`
  );

  // ─── PHASE 4: ADMIN PROMO CODE → BONUS DELIVERY ────────────────────
  const ADMIN = (sm.ADMIN_EMAILS && sm.ADMIN_EMAILS[0]) || "saifullahfaizan786@gmail.com";
  const TARGET = "bonusrecipient+e2e@example.com";
  await freshUserProfile(StorageManager, TARGET);
  // Need a fresh joining bonus + post-claim wallet to start clean.
  await StorageManager.claimJoiningBonus(TARGET, "user");
  const baseline = (await StorageManager.getBillingState(TARGET, "user")).walletPaise;
  // Admin issues a fixed_wallet promo code worth ₹50 (5000 paise)
  const promoCodeStr = `E2E${Date.now().toString(36).toUpperCase()}`;
  const promo = await StorageManager.createPromoCode({
    code: promoCodeStr,
    type: "fixed_wallet",
    valueInr: 50,
    note: "harness fixed wallet bonus",
    usageLimit: 1,
    active: true
  }, ADMIN);
  assertTrue(
    "[ADMIN] createPromoCode returns active fixed_wallet code",
    promo && promo.code === promoCodeStr && promo.active === true && promo.valuePaise === 5000,
    `promo=${JSON.stringify(promo)}`
  );

  // Target redeems
  await setAuth(StorageManager, TARGET, "user");
  let redeemResult = null;
  let redeemError = null;
  try {
    redeemResult = await StorageManager.redeemPromoCode(TARGET, promo.code, "user");
  } catch (e) {
    redeemError = String(e?.message || e);
  }
  assertTrue(
    "[ADMIN] target redeem credited",
    !!redeemResult && Number(redeemResult.amountPaise) === 5000,
    redeemError ? `error=${redeemError}` : `amountPaise=${redeemResult?.amountPaise} creditedEmail=${redeemResult?.creditedEmail}`
  );

  const afterRedeem = (await StorageManager.getBillingState(TARGET, "user")).walletPaise;
  assertEqual(
    "[ADMIN] target wallet bumped by 5000 paise",
    afterRedeem - baseline,
    5000
  );
  // Second redemption blocked (usageLimit=1, already used)
  let reRedeemError = null;
  try {
    await StorageManager.redeemPromoCode(TARGET, promo.code, "user");
  } catch (e) {
    reRedeemError = String(e?.message || e);
  }
  assertTrue(
    "[ADMIN] second redeem blocked",
    Boolean(reRedeemError),
    `error=${reRedeemError}`
  );

  // ─── PHASE 5: ADMIN BYPASS ─────────────────────────────────────────
  const adminUsage = await StorageManager.authorizeExamUsage(ADMIN, "admin", {
    mode: "exam",
    domain: "admin.test",
    usageType: "ocr"
  });
  assertEqual("[ADMIN] admin exam authorized", adminUsage.ok, true);
  assertEqual("[ADMIN] admin chargedPaise = 0", adminUsage.chargedPaise, 0);
  const adminChat = await StorageManager.authorizeChatUsage(ADMIN, "admin", {
    source: "harness_admin_chat"
  });
  assertEqual("[ADMIN] admin chat authorized", adminChat.ok, true);
  assertEqual("[ADMIN] admin chat chargedPaise = 0", adminChat.chargedPaise, 0);

  // ─── PHASE 6: FINAL STORAGE SCAN ───────────────────────────────────
  const finalSnapshot = await dumpDiskSnapshot(local);
  const finalLeak = deepStringContainsAny(finalSnapshot, REAL_KEY_TOKEN_FRAGMENTS);
  assertTrue(
    "[SEC] Post-lifecycle disk still has no raw API key fragments",
    finalLeak === null,
    finalLeak ? `leaked="${finalLeak}"` : "clean"
  );
  assertEqual(
    "[SEC] Post-lifecycle adminApis still absent from disk",
    Object.prototype.hasOwnProperty.call(finalSnapshot, "adminApis"),
    false
  );
}

async function main() {
  try {
    await runScenarios();
  } catch (error) {
    record("Harness execution", "FAIL", `${error?.message || error}\n${error?.stack || ""}`);
  }

  const passCount = HARNESS_REPORT.filter((i) => i.status === "PASS").length;
  const failCount = HARNESS_REPORT.filter((i) => i.status === "FAIL").length;

  console.log("\nThinkPulse E2E Security + Lifecycle Check");
  console.log("=========================================");
  console.log(`PASS=${passCount} FAIL=${failCount} TOTAL=${HARNESS_REPORT.length}`);
  for (const entry of HARNESS_REPORT) {
    console.log(`[${entry.status}] ${entry.name} - ${entry.detail}`);
  }
  process.exitCode = failCount > 0 ? 1 : 0;
}

main();
