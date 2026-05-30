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
  recordAdminWalletCredit,
  deleteRewardRecordsForEmail
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
  SYSTEM_KEY_MARKER,
  buildSystemApiCapabilities,
  handleProviderProxyRequest,
  protectUserStatePayload,
  sanitizeSystemServiceConfig,
  setPremiumServiceConfigRuntime
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
  "userocrapi",
  "onboarding"
]);
const USER_ACCOUNT_STATUS_SETTING_PREFIX = "user_account_status:";

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

function normalizeAccountStatus(value) {
  const safe = String(value || "").trim().toLowerCase();
  if (safe === "blocked" || safe === "deleted") {
    return safe;
  }
  return "active";
}

function buildUserAccountStatusKey(email) {
  const safeEmail = normalizeEmail(email);
  return safeEmail ? `${USER_ACCOUNT_STATUS_SETTING_PREFIX}${safeEmail}` : "";
}

function normalizeAccountStatusRecord(email, value = null) {
  const source = value && typeof value === "object" ? value : {};
  const status = normalizeAccountStatus(source.status);
  const apiBlocked = Boolean(source.apiBlocked || source.api_blocked);
  return {
    email: normalizeEmail(email),
    status,
    blocked: status === "blocked",
    deleted: status === "deleted",
    blockedAt: Math.max(0, Number(source.blockedAt) || 0),
    blockedByEmail: normalizeEmail(source.blockedByEmail || ""),
    deletedAt: Math.max(0, Number(source.deletedAt) || 0),
    deletedByEmail: normalizeEmail(source.deletedByEmail || ""),
    lastDeletedAt: Math.max(0, Number(source.lastDeletedAt || source.deletedAt) || 0),
    apiBlocked,
    apiBlockedAt: apiBlocked ? Math.max(0, Number(source.apiBlockedAt) || 0) : 0,
    apiBlockedByEmail: apiBlocked ? normalizeEmail(source.apiBlockedByEmail || source.apiBlockedBy || "") : "",
    apiBlockNote: apiBlocked ? String(source.apiBlockNote || source.apiReason || "").trim().slice(0, 220) : "",
    note: String(source.note || "").trim().slice(0, 220),
    updatedAt: Math.max(0, Number(source.updatedAt) || 0)
  };
}

async function getUserAccountStatus(email) {
  const safeEmail = normalizeEmail(email);
  const key = buildUserAccountStatusKey(safeEmail);
  if (!safeEmail || !key || !isSupabaseConfigured()) {
    return {
      found: false,
      status: normalizeAccountStatusRecord(safeEmail)
    };
  }

  const stored = await getGlobalJsonConfig(key);
  return {
    found: Boolean(stored?.found),
    source: stored?.table || "",
    status: normalizeAccountStatusRecord(safeEmail, stored?.found ? stored.value || {} : null)
  };
}

async function saveUserAccountStatus(email, patch = {}) {
  const safeEmail = normalizeEmail(email);
  const key = buildUserAccountStatusKey(safeEmail);
  if (!safeEmail || !key || !isSupabaseConfigured()) {
    return {
      stored: false,
      status: normalizeAccountStatusRecord(safeEmail, patch),
      reason: "Supabase is not configured."
    };
  }

  const previous = await getUserAccountStatus(safeEmail).catch(() => null);
  const status = normalizeAccountStatus(patch.status);
  const apiBlocked = typeof patch.apiBlocked === "boolean"
    ? patch.apiBlocked
    : Boolean(previous?.status?.apiBlocked);
  const now = Date.now();
  const record = normalizeAccountStatusRecord(safeEmail, {
    ...(previous?.status || {}),
    ...patch,
    status,
    blockedAt: status === "blocked"
      ? Math.max(0, Number(patch.blockedAt) || now)
      : 0,
    blockedByEmail: status === "blocked" ? patch.blockedByEmail : "",
    deletedAt: status === "deleted"
      ? Math.max(0, Number(patch.deletedAt) || now)
      : 0,
    deletedByEmail: status === "deleted" ? patch.deletedByEmail : "",
    lastDeletedAt: status === "deleted"
      ? Math.max(0, Number(patch.deletedAt) || now)
      : Math.max(0, Number(patch.lastDeletedAt || previous?.status?.lastDeletedAt) || 0),
    apiBlocked,
    apiBlockedAt: apiBlocked
      ? Math.max(0, Number(patch.apiBlockedAt || previous?.status?.apiBlockedAt) || now)
      : 0,
    apiBlockedByEmail: apiBlocked
      ? normalizeEmail(patch.apiBlockedByEmail || previous?.status?.apiBlockedByEmail || "")
      : "",
    apiBlockNote: apiBlocked
      ? String(patch.apiBlockNote || previous?.status?.apiBlockNote || "").trim().slice(0, 220)
      : "",
    updatedAt: now
  });
  const stored = await upsertGlobalJsonConfig(key, record);
  return {
    ...stored,
    status: record
  };
}

async function deleteAllUserStateConfigs(email) {
  const safeEmail = normalizeEmail(email);
  const results = {};
  if (!safeEmail || !isSupabaseConfigured()) {
    return results;
  }

  for (const namespace of USER_STATE_NAMESPACES) {
    results[namespace] = await deleteUserStateConfig(namespace, safeEmail).catch((error) => ({
      deleted: false,
      reason: error?.message || "Unable to delete user state."
    }));
  }
  return results;
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
  namespace: z.enum(["billing", "account", "settings", "userapis", "userocrapi", "onboarding"]),
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
const adminBlockBodySchema = z.object({
  email: emailSchema.optional(),
  userId: emailSchema.optional(),
  user_id: emailSchema.optional(),
  blocked: z.boolean().optional(),
  note: optionalSafeString(220)
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

function mergeStoredWebSearchMarkers(payload, previous) {
  const next = payload && typeof payload === "object" ? { ...payload } : {};
  const currentWebSearch = next.webSearch && typeof next.webSearch === "object" ? { ...next.webSearch } : {};
  const previousWebSearch = previous?.webSearch && typeof previous.webSearch === "object" ? previous.webSearch : {};
  for (const provider of ["tavily", "serper"]) {
    const requested = Array.isArray(currentWebSearch[provider]) ? currentWebSearch[provider] : [];
    if (!requested.some((key) => String(key || "").trim() === SYSTEM_KEY_MARKER)) {
      continue;
    }
    const previousKeys = Array.isArray(previousWebSearch[provider]) ? previousWebSearch[provider] : [];
    const merged = [...previousKeys, ...requested.filter((key) => String(key || "").trim() !== SYSTEM_KEY_MARKER)];
    currentWebSearch[provider] = merged;
  }
  next.webSearch = currentWebSearch;
  return next;
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
router.use("/users/status/:email", requireSelfOrAdmin([
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
    const rawConfig = stored?.found ? stored.value || {} : {};
    setPremiumServiceConfigRuntime(rawConfig);
    const systemCapabilities = buildSystemApiCapabilities();
    const metadata = sanitizeSystemServiceConfig(rawConfig);
    res.json({
      ok: true,
      premiumApis: {
        ...systemCapabilities,
        chatApis: mergeSuperiorSystemApis(systemCapabilities.chatApis, metadata.chatApis, ["superior_llm"]),
        ocrApis: mergeSuperiorSystemApis(systemCapabilities.ocrApis, metadata.ocrApis, ["superior_ocr"]),
        asrApis: metadata.asrApis.length ? metadata.asrApis : systemCapabilities.asrApis,
        imageApis: metadata.imageApis.length ? metadata.imageApis : systemCapabilities.imageApis,
        webSearch: metadata.webSearch || systemCapabilities.webSearch
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
    const previousStored = await getGlobalJsonConfig(PREMIUM_SERVICE_APIS_SETTING_KEY).catch(() => null);
    const previousConfig = previousStored?.found ? previousStored.value || {} : {};
    const requestedPayload = mergeStoredWebSearchMarkers(resolvePremiumApiPayload(req.body), previousConfig);
    const payload = sanitizeSystemServiceConfig(
      await validatePremiumServiceConfigEndpoints(requestedPayload),
      { preserveWebSearchKeys: true }
    );
    const stored = await upsertGlobalJsonConfig(PREMIUM_SERVICE_APIS_SETTING_KEY, payload);
    if (!stored?.stored) {
      throw new Error(stored?.reason || "Premium API settings table is not ready.");
    }
    setPremiumServiceConfigRuntime(stored.value || payload);

    res.json({
      ok: true,
      premiumApis: sanitizeSystemServiceConfig(stored.value || payload),
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
    const statusState = await getUserAccountStatus(email);
    const incomingAccountStatus = statusState.status;
    if (incomingAccountStatus.blocked) {
      res.status(403).json({
        ok: false,
        error: incomingAccountStatus.note || "Your account is blocked. Please contact admin support.",
        accountStatus: incomingAccountStatus
      });
      return;
    }
    if (incomingAccountStatus.deleted) {
      await deleteWalletSnapshot(email).catch(() => undefined);
      if (isSupabaseConfigured()) {
        await deleteUserPaymentRecords({ userId: email }).catch(() => undefined);
        await setUserPlanState({
          userId: email,
          plan: "free"
        }).catch(() => undefined);
      }
      await deleteAllUserStateConfigs(email).catch(() => undefined);
      await deleteRewardRecordsForEmail(email).catch(() => undefined);
    }

    const existingRegistryRecord = await getUserRegistryRecord(email);
    const existingPaymentRecord = existingRegistryRecord?.found
      ? existingRegistryRecord
      : await getUserPaymentPresence(email);
    const stored = await upsertUserRegistryRecord({
      email,
      createdAt: Date.now()
    });
    const isNewBackendUser = incomingAccountStatus.deleted || !existingPaymentRecord?.found;
    let joiningBonus = null;
    if (isNewBackendUser) {
      joiningBonus = await queueJoiningBonusForNewUser(email);
    }
    const activatedStatus = await saveUserAccountStatus(email, {
      status: "active",
      lastDeletedAt: incomingAccountStatus.lastDeletedAt,
      apiBlocked: incomingAccountStatus.deleted ? false : Boolean(incomingAccountStatus.apiBlocked),
      apiBlockedAt: incomingAccountStatus.deleted ? 0 : incomingAccountStatus.apiBlockedAt,
      apiBlockedByEmail: incomingAccountStatus.deleted ? "" : incomingAccountStatus.apiBlockedByEmail,
      apiBlockNote: incomingAccountStatus.deleted ? "" : incomingAccountStatus.apiBlockNote,
      note: ""
    }).catch(() => null);

    res.json({
      ok: true,
      stored,
      isNewBackendUser,
      joiningBonus,
      accountStatus: incomingAccountStatus,
      activeAccountStatus: activatedStatus?.status || null
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

router.get("/users/status/:email", validateRequest({ params: userPlanParamsSchema }), async (req, res) => {
  const email = normalizeEmail(req.params?.email);
  if (!email) {
    res.status(400).json({
      ok: false,
      error: "Valid email is required."
    });
    return;
  }

  try {
    const statusState = await getUserAccountStatus(email);
    res.json({
      ok: true,
      email,
      found: Boolean(statusState?.found),
      accountStatus: statusState.status,
      source: statusState?.source || ""
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error?.message || "Unable to fetch user account status."
    });
  }
});

router.post("/admin/users/credit-wallet", validateRequest({ body: adminCreditWalletBodySchema }), async (req, res) => {
  const email = normalizeEmail(req.body?.email || req.body?.userId || req.body?.user_id);
  const actorEmail = normalizeEmail(req.user?.email || req.body?.actorEmail);
  const amountInr = normalizeInrAmount(req.body?.amountInr || req.body?.amount);
  const note = String(
    req.body?.note ||
    `Wallet credited by admin ${actorEmail || "admin"}`
  ).trim().slice(0, 80) || `Wallet credited by admin ${actorEmail || "admin"}`;

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

router.post("/admin/users/block", validateRequest({ body: adminBlockBodySchema }), async (req, res) => {
  const email = normalizeEmail(req.body?.email || req.body?.userId || req.body?.user_id);
  const actorEmail = normalizeEmail(req.user?.email || "");
  const blocked = Boolean(req.body?.blocked);
  const note = String(
    req.body?.note ||
    (blocked ? `Blocked by ${actorEmail || "admin"}` : `Unblocked by ${actorEmail || "admin"}`)
  ).trim().slice(0, 220);

  if (!email) {
    res.status(400).json({
      ok: false,
      error: "Valid email is required."
    });
    return;
  }

  try {
    const role = await resolveTrustedRole(email);
    if (role === "admin") {
      res.status(400).json({
        ok: false,
        error: "Admin accounts cannot be blocked."
      });
      return;
    }

    const previous = await getUserAccountStatus(email).catch(() => null);
    const stored = await saveUserAccountStatus(email, {
      status: blocked ? "blocked" : "active",
      blockedByEmail: blocked ? actorEmail : "",
      note: blocked ? note : "",
      lastDeletedAt: previous?.status?.lastDeletedAt || 0
    });

    res.json({
      ok: true,
      email,
      blocked,
      accountStatus: stored.status,
      source: stored.table || ""
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error?.message || "Unable to update user access."
    });
  }
});

router.post("/admin/users/api-block", validateRequest({ body: adminBlockBodySchema }), async (req, res) => {
  const email = normalizeEmail(req.body?.email || req.body?.userId || req.body?.user_id);
  const actorEmail = normalizeEmail(req.user?.email || "");
  const blocked = Boolean(req.body?.blocked);
  const note = String(
    req.body?.note ||
    (blocked ? `API blocked by ${actorEmail || "admin"}` : `API unblocked by ${actorEmail || "admin"}`)
  ).trim().slice(0, 220);

  if (!email) {
    res.status(400).json({
      ok: false,
      error: "Valid email is required."
    });
    return;
  }

  try {
    const role = await resolveTrustedRole(email);
    if (role === "admin") {
      res.status(400).json({
        ok: false,
        error: "Admin accounts cannot be API-blocked."
      });
      return;
    }

    const previous = await getUserAccountStatus(email).catch(() => null);
    const currentStatus = normalizeAccountStatus(previous?.status?.status);
    if (currentStatus === "deleted") {
      res.status(400).json({
        ok: false,
        error: "Deleted accounts cannot be API-blocked."
      });
      return;
    }
    if (blocked) {
      const planState = await getUserPlanState({ userId: email }).catch(() => null);
      const effectivePlan = normalizePlan(planState?.found ? planState.plan : "free") || "free";
      if (effectivePlan !== "free") {
        res.status(400).json({
          ok: false,
          error: "Block API is only available for Free users."
        });
        return;
      }
    }

    const stored = await saveUserAccountStatus(email, {
      status: currentStatus,
      blockedAt: previous?.status?.blockedAt || 0,
      blockedByEmail: previous?.status?.blockedByEmail || "",
      note: previous?.status?.note || "",
      lastDeletedAt: previous?.status?.lastDeletedAt || 0,
      apiBlocked: blocked,
      apiBlockedAt: blocked ? Date.now() : 0,
      apiBlockedByEmail: blocked ? actorEmail : "",
      apiBlockNote: blocked ? note : ""
    });

    res.json({
      ok: true,
      email,
      apiBlocked: blocked,
      accountStatus: stored.status,
      source: stored.table || ""
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error?.message || "Unable to update user API access."
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
    const role = await resolveTrustedRole(email);
    if (role === "admin") {
      res.status(400).json({
        ok: false,
        error: "Admin accounts cannot be deleted."
      });
      return;
    }

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
    const userState = await deleteAllUserStateConfigs(email);
    const rewards = await deleteRewardRecordsForEmail(email).catch((error) => ({
      ok: false,
      error: error?.message || "Unable to delete reward records."
    }));
    const deletedAt = Date.now();
    const accountStatus = await saveUserAccountStatus(email, {
      status: "deleted",
      deletedAt,
      deletedByEmail: normalizeEmail(req.user?.email || ""),
      apiBlocked: false,
      apiBlockedAt: 0,
      apiBlockedByEmail: "",
      apiBlockNote: "",
      note: "Deleted by admin"
    }).catch(() => null);

    res.json({
      ok: true,
      email,
      wallet,
      payments,
      planReset,
      userState,
      rewards,
      accountStatus: accountStatus?.status || normalizeAccountStatusRecord(email, {
        status: "deleted",
        deletedAt
      })
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
