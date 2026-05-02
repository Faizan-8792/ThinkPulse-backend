"use strict";

const express = require("express");

const {
  isConfigured: isSupabaseConfigured,
  setUserPlanState,
  getUserPlanState,
  getUserRegistryRecord,
  getUserPaymentPresence,
  upsertUserRegistryRecord,
  listKnownUsersFromPayments,
  deleteUserPaymentRecords,
  getGlobalJsonConfig,
  upsertGlobalJsonConfig,
  getUserStateConfig,
  upsertUserStateConfig,
  deleteUserStateConfig,
  listUserStateConfigs
} = require("../payments/supabase_store");
const {
  creditWallet,
  getWalletSnapshot,
  deleteWalletSnapshot
} = require("../payments/wallet_store");
const {
  ensureJoiningBonusAvailableNotification,
  recordAdminWalletCredit
} = require("../rewards/rewards_store");

const {
  authenticateRequest,
  requireRole,
  requireSelfOrAdmin,
  resolveTrustedRole
} = require("../security/auth");
const {
  createIdempotencyMiddleware
} = require("../security/idempotency");
const {
  validatePremiumServiceConfigEndpoints
} = require("../security/network");
const {
  createUserRateLimiter
} = require("../security/rate_limit");
const {
  buildSystemApiCapabilities,
  handleProviderProxyRequest,
  protectUserStatePayload,
  sanitizeSystemServiceConfig
} = require("../providers/provider_proxy");
const {
  z,
  validateRequest,
  safeString,
  optionalSafeString,
  emailSchema
} = require("../security/validation");

const router = express.Router();
const PREMIUM_SERVICE_APIS_SETTING_KEY = "premium_service_apis_v1";
const USER_STATE_NAMESPACES = new Set([
  "billing",
  "account",
  "settings",
  "userapis",
  "userocrapi"
]);

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

function normalizeStateNamespace(value) {
  const safe = String(value || "").trim().toLowerCase();
  return USER_STATE_NAMESPACES.has(safe) ? safe : "";
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

async function queueJoiningBonusForNewUser(email) {
  const safeEmail = normalizeEmail(email);
  if (!safeEmail) {
    return null;
  }

  const role = await resolveTrustedRole(safeEmail);
  if (role === "admin") {
    return {
      skipped: true,
      reason: "admin_ineligible"
    };
  }

  return ensureJoiningBonusAvailableNotification(safeEmail);
}

const premiumApiEntrySchema = z.object({
  provider: safeString(40),
  key: safeString(500),
  model: optionalSafeString(200),
  endpoint: optionalSafeString(2000),
  enabled: z.boolean().optional(),
  order: z.coerce.number().int().min(0).max(1000).optional()
}).passthrough();
const premiumApiConfigSchema = z.object({
  multiApiMode: z.boolean().optional(),
  chatApis: z.array(premiumApiEntrySchema).max(50).optional(),
  ocrApis: z.array(premiumApiEntrySchema).max(50).optional(),
  asrApis: z.array(premiumApiEntrySchema).max(50).optional(),
  imageApis: z.array(premiumApiEntrySchema).max(50).optional(),
  webSearch: z.object({
    tavily: z.array(safeString(500)).max(50).optional(),
    serper: z.array(safeString(500)).max(50).optional()
  }).passthrough().optional()
}).passthrough();
const premiumApiWriteSchema = z.object({
  premiumApis: premiumApiConfigSchema.optional(),
  config: premiumApiConfigSchema.optional()
}).passthrough();

function normalizePublicOcrApiEntry(entry, index = 0) {
  if (!entry || typeof entry !== "object" || entry.enabled === false) {
    return null;
  }

  const provider = String(entry.provider || "").trim().toLowerCase().slice(0, 40);
  const key = String(entry.key || "").trim().slice(0, 500);
  if (!provider || !key) {
    return null;
  }

  return {
    provider,
    key,
    model: String(entry.model || "").trim().slice(0, 200),
    endpoint: String(entry.endpoint || "").trim().slice(0, 2000),
    enabled: true,
    order: Number.isFinite(Number(entry.order)) ? Number(entry.order) : index
  };
}

const userStateParamsSchema = z.object({
  namespace: z.enum(["billing", "account", "settings", "userapis", "userocrapi"]),
  email: emailSchema
});
const userStateWriteSchema = z.object({
  value: z.record(z.any()).optional()
}).passthrough();
const userStateListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(5000).optional()
}).passthrough();
const userUpsertBodySchema = z.object({
  email: emailSchema.optional(),
  userId: emailSchema.optional(),
  user_id: emailSchema.optional()
}).passthrough();
const adminSetPlanBodySchema = z.object({
  email: emailSchema.optional(),
  userId: emailSchema.optional(),
  user_id: emailSchema.optional(),
  plan: z.enum(["free", "basic", "premium", "admin"])
}).passthrough();
const userPlanParamsSchema = z.object({
  email: emailSchema
});
const adminCreditWalletBodySchema = z.object({
  email: emailSchema.optional(),
  userId: emailSchema.optional(),
  user_id: emailSchema.optional(),
  amountInr: z.coerce.number().positive().max(100000).optional(),
  amount: z.coerce.number().positive().max(100000).optional(),
  note: optionalSafeString(80),
  actorEmail: emailSchema.optional()
}).passthrough();
const adminDeleteBodySchema = z.object({
  email: emailSchema.optional(),
  userId: emailSchema.optional(),
  user_id: emailSchema.optional()
}).passthrough();

function resolvePremiumApiPayload(body) {
  if (body?.premiumApis && typeof body.premiumApis === "object") {
    return body.premiumApis;
  }
  if (body?.config && typeof body.config === "object") {
    return body.config;
  }
  return {};
}

function mergeSuperiorSystemApis(systemApis, metadataApis, superiorProviders) {
  const systemList = Array.isArray(systemApis) ? systemApis : [];
  const metadataList = Array.isArray(metadataApis) ? metadataApis : [];
  const superiorSet = new Set((superiorProviders || []).map((provider) => String(provider || "").trim().toLowerCase()));
  const output = [];
  const seen = new Set();
  const push = (entry) => {
    if (!entry || typeof entry !== "object") {
      return;
    }
    const provider = String(entry.provider || "").trim().toLowerCase();
    const identity = String(entry.id || `${provider}:${entry.endpoint || ""}:${entry.model || ""}`).trim();
    if (!provider || seen.has(identity)) {
      return;
    }
    seen.add(identity);
    output.push({
      ...entry,
      order: output.length
    });
  };

  systemList.filter((entry) => superiorSet.has(String(entry?.provider || "").trim().toLowerCase())).forEach(push);
  (metadataList.length ? metadataList : systemList).forEach(push);
  return output;
}

router.use(authenticateRequest());
router.use("/admin", requireRole("admin"));
router.use("/users/state/:namespace/:email", requireSelfOrAdmin([
  { source: "params", key: "email" }
]));
router.use("/users/upsert", requireSelfOrAdmin([
  { source: "body", key: "email" },
  { source: "body", key: "userId" },
  { source: "body", key: "user_id" }
]));
router.use("/users/plan/:email", requireSelfOrAdmin([
  { source: "params", key: "email" }
]));
router.use(
  "/admin/users/credit-wallet",
  createUserRateLimiter({
    scope: "payments",
    windowMs: 60 * 1000,
    max: 5,
    keyResolver: (req) => String(req.user?.email || "").trim().toLowerCase(),
    message: "Too many payment-related requests. Please slow down."
  }),
  createIdempotencyMiddleware({
    scope: "admin_wallet_credit",
    ttlMs: 10 * 60 * 1000
  })
);

router.post(
  "/proxy/:service",
  createUserRateLimiter({
    scope: "provider_proxy",
    windowMs: 60 * 1000,
    max: 300,
    keyResolver: (req) => String(req.user?.email || "").trim().toLowerCase(),
    message: "Too many AI provider requests. Please slow down."
  }),
  handleProviderProxyRequest
);

router.get("/config/premium-service-apis", async (_req, res) => {
  if (!isSupabaseConfigured()) {
    res.json({
      ok: true,
      premiumApis: buildSystemApiCapabilities(),
      source: "system",
      found: false
    });
    return;
  }

  try {
    const stored = await getGlobalJsonConfig(PREMIUM_SERVICE_APIS_SETTING_KEY);
    const systemCapabilities = buildSystemApiCapabilities();
    const metadata = sanitizeSystemServiceConfig(stored?.found ? stored.value || {} : {});
    res.json({
      ok: true,
      premiumApis: {
        ...systemCapabilities,
        chatApis: mergeSuperiorSystemApis(systemCapabilities.chatApis, metadata.chatApis, ["superior_llm"]),
        ocrApis: mergeSuperiorSystemApis(systemCapabilities.ocrApis, metadata.ocrApis, ["superior_ocr"]),
        asrApis: metadata.asrApis.length ? metadata.asrApis : systemCapabilities.asrApis,
        imageApis: metadata.imageApis.length ? metadata.imageApis : systemCapabilities.imageApis
      },
      source: stored?.table || "",
      found: Boolean(stored?.found)
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error?.message || "Unable to load premium API settings."
    });
  }
});

router.get("/config/system-api-capabilities", async (_req, res) => {
  try {
    res.json({
      ok: true,
      capabilities: buildSystemApiCapabilities()
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error?.message || "Unable to load system API capabilities."
    });
  }
});

router.get("/config/shared-ocr-api", async (_req, res) => {
  try {
    const capabilities = buildSystemApiCapabilities();
    const ocrApis = (Array.isArray(capabilities.ocrApis) ? capabilities.ocrApis : [])
      .filter((api) => String(api?.provider || "").trim().toLowerCase() !== "superior_ocr");
    res.json({
      ok: true,
      ocrApis,
      ocrApi: ocrApis[0] || null,
      source: "env",
      found: Boolean(ocrApis.length)
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error?.message || "Unable to load shared OCR API settings."
    });
  }
});

router.post("/admin/config/premium-service-apis", validateRequest({ body: premiumApiWriteSchema }), async (req, res) => {
  if (!isSupabaseConfigured()) {
    res.status(503).json({
      ok: false,
      error: "Supabase is not configured on the server."
    });
    return;
  }

  try {
    const payload = sanitizeSystemServiceConfig(
      await validatePremiumServiceConfigEndpoints(resolvePremiumApiPayload(req.body))
    );
    const stored = await upsertGlobalJsonConfig(PREMIUM_SERVICE_APIS_SETTING_KEY, payload);
    if (!stored?.stored) {
      throw new Error(stored?.reason || "Premium API settings table is not ready.");
    }

    res.json({
      ok: true,
      premiumApis: sanitizeSystemServiceConfig(stored.value || {}),
      source: stored.table || ""
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error?.message || "Unable to save premium API settings."
    });
  }
});

router.get("/users/state/:namespace/:email", validateRequest({ params: userStateParamsSchema }), async (req, res) => {
  if (!isSupabaseConfigured()) {
    res.status(503).json({
      ok: false,
      error: "Supabase is not configured on the server."
    });
    return;
  }

  const namespace = normalizeStateNamespace(req.params?.namespace);
  const email = normalizeEmail(req.params?.email);
  if (!namespace) {
    res.status(400).json({
      ok: false,
      error: "Valid namespace is required."
    });
    return;
  }
  if (!email) {
    res.status(400).json({
      ok: false,
      error: "Valid email is required."
    });
    return;
  }

  try {
    const stored = await getUserStateConfig(namespace, email);
    res.json({
      ok: true,
      namespace,
      email,
      found: Boolean(stored?.found),
      value: stored?.found ? stored.value || {} : null,
      source: stored?.table || ""
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error?.message || "Unable to load user state."
    });
  }
});

router.post("/users/state/:namespace/:email", validateRequest({ params: userStateParamsSchema, body: userStateWriteSchema }), async (req, res) => {
  if (!isSupabaseConfigured()) {
    res.status(503).json({
      ok: false,
      error: "Supabase is not configured on the server."
    });
    return;
  }

  const namespace = normalizeStateNamespace(req.params?.namespace);
  const email = normalizeEmail(req.params?.email);
  if (!namespace) {
    res.status(400).json({
      ok: false,
      error: "Valid namespace is required."
    });
    return;
  }
  if (!email) {
    res.status(400).json({
      ok: false,
      error: "Valid email is required."
    });
    return;
  }

  try {
    const rawValue = req.body?.value && typeof req.body.value === "object"
      ? req.body.value
      : req.body && typeof req.body === "object"
        ? req.body
        : {};
    const protectedValue = protectUserStatePayload(namespace, email, rawValue);
    const stored = await upsertUserStateConfig(
      namespace,
      email,
      protectedValue
    );

    res.json({
      ok: true,
      namespace,
      email,
      value: stored?.value || {},
      source: stored?.table || ""
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error?.message || "Unable to save user state."
    });
  }
});

router.delete("/users/state/:namespace/:email", validateRequest({ params: userStateParamsSchema }), async (req, res) => {
  if (!isSupabaseConfigured()) {
    res.status(503).json({
      ok: false,
      error: "Supabase is not configured on the server."
    });
    return;
  }

  const namespace = normalizeStateNamespace(req.params?.namespace);
  const email = normalizeEmail(req.params?.email);
  if (!namespace) {
    res.status(400).json({
      ok: false,
      error: "Valid namespace is required."
    });
    return;
  }
  if (!email) {
    res.status(400).json({
      ok: false,
      error: "Valid email is required."
    });
    return;
  }

  try {
    const deleted = await deleteUserStateConfig(namespace, email);
    res.json({
      ok: true,
      namespace,
      email,
      deleted: Boolean(deleted?.deleted),
      count: Number(deleted?.count || 0),
      source: deleted?.table || ""
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error?.message || "Unable to delete user state."
    });
  }
});

router.get("/admin/users/state/:namespace", validateRequest({ query: userStateListQuerySchema }), async (req, res) => {
  if (!isSupabaseConfigured()) {
    res.status(503).json({
      ok: false,
      error: "Supabase is not configured on the server."
    });
    return;
  }

  const namespace = normalizeStateNamespace(req.params?.namespace);
  if (!namespace) {
    res.status(400).json({
      ok: false,
      error: "Valid namespace is required."
    });
    return;
  }

  try {
    const listed = await listUserStateConfigs(namespace, Number(req.query?.limit) || 5000);
    res.json({
      ok: true,
      namespace,
      items: Array.isArray(listed?.items) ? listed.items : [],
      count: Array.isArray(listed?.items) ? listed.items.length : 0
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error?.message || "Unable to list user states."
    });
  }
});

router.post("/users/upsert", validateRequest({ body: userUpsertBodySchema }), async (req, res) => {
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
    const existingRegistryRecord = await getUserRegistryRecord(email);
    const existingPaymentRecord = existingRegistryRecord?.found
      ? existingRegistryRecord
      : await getUserPaymentPresence(email);
    const stored = await upsertUserRegistryRecord({
      email,
      createdAt: Date.now()
    });
    const isNewBackendUser = !existingPaymentRecord?.found;
    let joiningBonus = null;
    if (isNewBackendUser) {
      joiningBonus = await queueJoiningBonusForNewUser(email);
    }

    res.json({
      ok: true,
      stored,
      isNewBackendUser,
      joiningBonus
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

router.post("/admin/users/set-plan", validateRequest({ body: adminSetPlanBodySchema }), async (req, res) => {
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

router.get("/users/plan/:email", validateRequest({ params: userPlanParamsSchema }), async (req, res) => {
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

router.post("/admin/users/credit-wallet", validateRequest({ body: adminCreditWalletBodySchema }), async (req, res) => {
  const email = normalizeEmail(req.body?.email || req.body?.userId || req.body?.user_id);
  const amountInr = normalizeInrAmount(req.body?.amountInr || req.body?.amount);
  const note = String(req.body?.note || "admin_wallet_credit").trim().slice(0, 80) || "admin_wallet_credit";
  const actorEmail = normalizeEmail(req.user?.email || req.body?.actorEmail);

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
      source: `bonus:${note}`
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
      wallet: await getWalletSnapshot(email)
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error?.message || "Unable to apply admin wallet credit."
    });
  }
});

router.post("/admin/users/delete", validateRequest({ body: adminDeleteBodySchema }), async (req, res) => {
  const email = normalizeEmail(req.body?.email || req.body?.userId || req.body?.user_id);
  if (!email) {
    res.status(400).json({
      ok: false,
      error: "Valid email is required."
    });
    return;
  }

  try {
    const wallet = await deleteWalletSnapshot(email);
    let payments = {
      deleted: false,
      count: 0,
      reason: "Supabase is not configured."
    };
    let planReset = {
      updated: false,
      reason: "Supabase is not configured."
    };

    if (isSupabaseConfigured()) {
      payments = await deleteUserPaymentRecords({ userId: email });
      planReset = await setUserPlanState({
        userId: email,
        plan: "free"
      });
    }

    res.json({
      ok: true,
      email,
      wallet,
      payments,
      planReset
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error?.message || "Unable to delete user records."
    });
  }
});

module.exports = {
  usersRouter: router
};
