"use strict";

const fs = require("fs");
const path = require("path");

const {
  getUserPlanState,
  listKnownUsersFromPayments,
  isConfigured: isSupabaseConfigured,
  getGlobalJsonConfig,
  upsertGlobalJsonConfig
} = require("../payments/supabase_store");
const { creditWallet, hasJoiningBonusPayment } = require("../payments/wallet_store");
const { resolveStorePath } = require("../storage/store_path");

const JOINING_BONUS_PAISE = 2000;
const MAX_NOTIFICATIONS = 6000;
const MAX_NOTIFICATIONS_PER_EMAIL = 200;
const MAX_REWARD_EVENTS = 6000;
const MAX_NOTIFICATION_RECEIPTS_PER_EMAIL = 600;
const MAX_PROMO_REDEMPTIONS = 500;
const REWARDS_STORE_CONFIG_KEY = "thinkpulse_rewards_store_v1";
const rewardsStorePath = resolveStorePath(process.env.REWARDS_STORE_PATH, "rewards.json");

/**
 * Serialises concurrent operations against the same key. Returns a promise
 * that resolves once `task` completes; subsequent callers for the same key
 * await the in-flight promise so the protected block runs at most once at
 * a time per key. Used to make claimJoiningBonus / redeemPromoCode atomic
 * across overlapping requests.
 */
const inflightMutexes = new Map();
function withKeyedMutex(key, task) {
  const safeKey = String(key || "").trim();
  if (!safeKey) {
    return task();
  }
  const previous = inflightMutexes.get(safeKey) || Promise.resolve();
  const next = previous.catch(() => undefined).then(() => task());
  inflightMutexes.set(
    safeKey,
    next.finally(() => {
      if (inflightMutexes.get(safeKey) === next) {
        inflightMutexes.delete(safeKey);
      }
    })
  );
  return next;
}

let store = {
  promos: {},
  bonusProfiles: {},
  notifications: [],
  notificationReceipts: {},
  rewardEvents: [],
  updatedAt: Date.now()
};

let initialized = false;
let persistQueue = Promise.resolve();

/**
 * Converts unknown value to bounded string.
 * @param {unknown} value
 * @param {number=} maxLength
 * @returns {string}
 */
function toSafeString(value, maxLength = 180) {
  return String(value || "").trim().slice(0, maxLength);
}

/**
 * Converts unknown value to bounded lowercase email identifier.
 * @param {unknown} value
 * @returns {string}
 */
function normalizeEmail(value) {
  const safe = toSafeString(value, 180).toLowerCase();
  return safe.includes("@") ? safe : "";
}

/**
 * Returns true when the email belongs to an admin account in backend plan state.
 * Falls back to false when plan state is unavailable.
 * @param {string} email
 * @returns {Promise<boolean>}
 */
async function isAdminEmail(email) {
  const safeEmail = normalizeEmail(email);
  if (!safeEmail) {
    return false;
  }

  try {
    const planState = await getUserPlanState({ userId: safeEmail });
    return String(planState?.plan || "").trim().toLowerCase() === "admin";
  } catch (_error) {
    return false;
  }
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

/**
 * Returns normalized promo type.
 * @param {unknown} value
 * @returns {"fixed_wallet"|"percent_wallet"|"invite_bonus"}
 */
function normalizePromoType(value) {
  const safe = String(value || "").trim().toLowerCase();
  if (safe === "percent" || safe === "percent_wallet") {
    return "percent_wallet";
  }
  if (safe === "invite" || safe === "invite_bonus") {
    return "invite_bonus";
  }
  return "fixed_wallet";
}

/**
 * Normalizes truthy boolean-like values.
 * @param {unknown} value
 * @param {boolean=} fallback
 * @returns {boolean}
 */
function normalizeBoolean(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }
  const safe = String(value || "").trim().toLowerCase();
  if (safe === "true" || safe === "1" || safe === "yes") {
    return true;
  }
  if (safe === "false" || safe === "0" || safe === "no") {
    return false;
  }
  return fallback;
}

/**
 * Converts supported date-like values to epoch milliseconds.
 * @param {unknown} value
 * @returns {number}
 */
function toEpochMs(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric > 1_000_000_000_000 ? Math.round(numeric) : Math.round(numeric * 1000);
  }

  const parsed = new Date(String(value || ""));
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.getTime();
  }

  return 0;
}

/**
 * Rounds amount to paise integer with non-negative floor.
 * @param {unknown} value
 * @returns {number}
 */
function normalizePaise(value) {
  return Math.max(0, Math.round(Number(value) || 0));
}

/**
 * Rounds amount to INR number with 2 decimals.
 * @param {unknown} value
 * @returns {number}
 */
function normalizeInr(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }
  return Math.round(numeric * 100) / 100;
}

/**
 * Computes reward paise for one promo record.
 * @param {object|null|undefined} promo
 * @returns {number}
 */
function calculatePromoRewardPaise(promo) {
  if (!promo || typeof promo !== "object") {
    return 0;
  }

  if (promo.type === "percent_wallet") {
    const percent = Math.max(1, Math.min(95, Math.round(Number(promo.percent) || 0)));
    const basePaise = Math.max(100, Math.round(Number(promo.percentBasePaise) || 0));
    let rewardPaise = Math.round((basePaise * percent) / 100);
    const maxRewardPaise = Math.max(0, Math.round(Number(promo.maxRewardPaise) || 0));
    if (maxRewardPaise > 0) {
      rewardPaise = Math.min(rewardPaise, maxRewardPaise);
    }
    return Math.max(100, rewardPaise);
  }

  return Math.max(100, Math.round(Number(promo.valuePaise) || 0));
}
/**
 * Builds deterministic-ish invite code seed from email.
 * @param {string} email
 * @returns {string}
 */
function buildInviteSeed(email) {
  const safeEmail = normalizeEmail(email);
  const local = safeEmail.split("@")[0] || "USER";
  const compact = local.replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, 8) || "USER";
  return compact;
}

/**
 * Creates a unique invite code for one owner.
 * @param {string} ownerEmail
 * @returns {string}
 */
function generateInviteCode(ownerEmail) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const lettersOnly = buildInviteSeed(ownerEmail).replace(/[^A-Z]/g, "");
  const prefix = (lettersOnly.slice(0, 3) || "INV").padEnd(3, "X").slice(0, 3);
  let attempt = 0;
  while (attempt < 1000) {
    let suffix = "";
    let hasDigit = false;
    for (let index = 0; index < 5; index += 1) {
      const nextChar = alphabet[Math.floor(Math.random() * alphabet.length)] || "2";
      if (/\d/.test(nextChar)) {
        hasDigit = true;
      }
      suffix += nextChar;
    }
    if (!hasDigit) {
      suffix = `${suffix.slice(0, 4)}${String(Math.floor(Math.random() * 8) + 2)}`;
    }
    const candidate = sanitizePromoCode(`${prefix}${suffix}`);
    if (candidate && !store.promos[candidate]) {
      return candidate;
    }
    attempt += 1;
  }
  const fallback = sanitizePromoCode(`${prefix}${String(Date.now()).slice(-5)}`);
  if (fallback && !store.promos[fallback]) {
    return fallback;
  }
  return sanitizePromoCode(`${prefix}${Math.random().toString(36).slice(2, 7).toUpperCase()}`);
}

function getPromoInstanceKey(promo, fallbackValue = Date.now()) {
  const createdAt = Math.max(0, Number(promo?.createdAt || 0));
  const updatedAt = Math.max(0, Number(promo?.updatedAt || 0));
  const fallback = Math.max(0, Number(fallbackValue || 0));
  return String(createdAt || fallback || updatedAt || Date.now());
}

function normalizePromoRecord(value, fallbackCode = "") {
  if (!value || typeof value !== "object") {
    return null;
  }
  const code = sanitizePromoCode(value.code || fallbackCode);
  if (!code) {
    return null;
  }
  const now = Date.now();
  const type = normalizePromoType(value.type);
  const redemptions = (Array.isArray(value.redemptions) ? value.redemptions : [])
    .map((entry) => {
      const redeemerEmail = normalizeEmail(entry?.redeemerEmail || entry?.email);
      const creditedEmail = normalizeEmail(entry?.creditedEmail || entry?.email || redeemerEmail);
      if (!redeemerEmail && !creditedEmail) {
        return null;
      }
      return {
        redeemerEmail,
        creditedEmail,
        amountPaise: normalizePaise(entry?.amountPaise),
        createdAt: toEpochMs(entry?.createdAt) || now
      };
    })
    .filter(Boolean)
    .slice(0, MAX_PROMO_REDEMPTIONS);

  return {
    code,
    type,
    active: normalizeBoolean(value.active, true),
    assignedToEmail: normalizeEmail(value.assignedToEmail),
    createdByEmail: normalizeEmail(value.createdByEmail),
    note: toSafeString(value.note, 220),
    valuePaise: normalizePaise(value.valuePaise),
    percent: Math.max(0, Math.min(95, Math.round(Number(value.percent) || 0))),
    percentBasePaise: normalizePaise(value.percentBasePaise),
    maxRewardPaise: normalizePaise(value.maxRewardPaise),
    usageLimit: type === "invite_bonus"
      ? 1
      : Math.max(1, Math.min(MAX_PROMO_REDEMPTIONS, Math.round(Number(value.usageLimit) || 1))),
    usedCount: Math.max(0, Math.round(Number(value.usedCount) || redemptions.length)),
    blockedSelfUse: value.blockedSelfUse !== false,
    redemptions,
    createdAt: toEpochMs(value.createdAt) || now,
    updatedAt: toEpochMs(value.updatedAt) || now,
    expiresAt: Math.max(0, toEpochMs(value.expiresAt)),
    latestRedeemerEmail: normalizeEmail(value.latestRedeemerEmail),
    latestCreditedEmail: normalizeEmail(value.latestCreditedEmail),
    latestRedemptionAt: Math.max(0, toEpochMs(value.latestRedemptionAt))
  };
}

function normalizeStorePayload(value) {
  const source = value && typeof value === "object" ? value : {};
  const next = {
    promos: {},
    bonusProfiles: {},
    notifications: [],
    notificationReceipts: {},
    rewardEvents: [],
    updatedAt: Math.max(0, Number(source.updatedAt || Date.now()))
  };

  for (const [rawCode, promo] of Object.entries(source.promos || {})) {
    const normalized = normalizePromoRecord(promo, rawCode);
    if (normalized) {
      next.promos[normalized.code] = normalized;
    }
  }
  for (const [rawEmail, profile] of Object.entries(source.bonusProfiles || {})) {
    const email = normalizeEmail(rawEmail);
    if (!email) {
      continue;
    }
    next.bonusProfiles[email] = {
      firstSeenAt: toEpochMs(profile?.firstSeenAt) || Date.now(),
      joiningClaimedAt: Math.max(0, toEpochMs(profile?.joiningClaimedAt)),
      joiningBonusPaise: normalizePaise(profile?.joiningBonusPaise),
      updatedAt: toEpochMs(profile?.updatedAt) || Date.now()
    };
  }
  next.notifications = (Array.isArray(source.notifications) ? source.notifications : [])
    .map((item) => ({
      id: toSafeString(item?.id, 80) || `notification:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      email: normalizeEmail(item?.email),
      kind: toSafeString(item?.kind, 80),
      title: toSafeString(item?.title, 120),
      message: toSafeString(item?.message, 360),
      actionTarget: toSafeString(item?.actionTarget, 80),
      code: sanitizePromoCode(item?.code),
      read: normalizeBoolean(item?.read, false),
      readAt: Math.max(0, toEpochMs(item?.readAt)),
      createdAt: toEpochMs(item?.createdAt) || Date.now(),
      dedupeKey: toSafeString(item?.dedupeKey, 220)
    }))
    .filter((item) => item.email);
  next.notifications = trimNotificationsByEmail(next.notifications, MAX_NOTIFICATIONS_PER_EMAIL).slice(0, MAX_NOTIFICATIONS);
  next.rewardEvents = (Array.isArray(source.rewardEvents) ? source.rewardEvents : [])
    .map((event) => ({
      id: toSafeString(event?.id, 80) || `reward:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      kind: toSafeString(event?.kind, 80),
      email: normalizeEmail(event?.email),
      actorEmail: normalizeEmail(event?.actorEmail),
      creditedEmail: normalizeEmail(event?.creditedEmail),
      code: sanitizePromoCode(event?.code),
      promoType: toSafeString(event?.promoType, 80),
      amountPaise: normalizePaise(event?.amountPaise),
      note: toSafeString(event?.note, 240),
      createdAt: toEpochMs(event?.createdAt) || Date.now()
    }))
    .slice(0, MAX_REWARD_EVENTS);
  next.notificationReceipts = source.notificationReceipts && typeof source.notificationReceipts === "object"
    ? source.notificationReceipts
    : {};
  return next;
}

let loadPromise = null;

/**
 * Loads the rewards store from Supabase (primary, durable) or local file
 * (fallback). This is async and MUST be awaited before any store access.
 * All public functions call this first.
 */
async function ensureLoaded() {
  if (initialized) {
    return;
  }
  if (loadPromise) {
    await loadPromise;
    return;
  }
  loadPromise = (async () => {
    try {
      // Supabase is the source of truth — it survives Azure redeploys.
      // Hard timeout so a slow Supabase doesn't block the entire server.
      if (isSupabaseConfigured()) {
        const remote = await Promise.race([
          getGlobalJsonConfig(REWARDS_STORE_CONFIG_KEY),
          new Promise((resolve) => setTimeout(() => resolve(null), 8000))
        ]);
        if (remote?.found && remote.value && typeof remote.value === "object") {
          store = normalizeStorePayload(remote.value);
          initialized = true;
          return;
        }
      }
    } catch (error) {
      console.warn("[rewards-store] Supabase load failed, falling back to file:", error?.message || error);
    }
    // Fallback: local file (only useful for local dev or first-ever boot).
    try {
      if (fs.existsSync(rewardsStorePath)) {
        store = normalizeStorePayload(JSON.parse(fs.readFileSync(rewardsStorePath, "utf8")));
      } else {
        store = normalizeStorePayload(store);
      }
    } catch (error) {
      console.warn("[rewards-store] File load failed:", error?.message || error);
      store = normalizeStorePayload(store);
    }
    initialized = true;
  })();
  await loadPromise;
  loadPromise = null;
}

function persistStore() {
  store.updatedAt = Date.now();
  const snapshot = normalizeStorePayload(store);
  persistQueue = persistQueue
    .catch(() => undefined)
    .then(async () => {
      // Write to Supabase FIRST (durable, source of truth).
      if (isSupabaseConfigured()) {
        try {
          await upsertGlobalJsonConfig(REWARDS_STORE_CONFIG_KEY, snapshot);
        } catch (error) {
          console.warn("[rewards-store] Supabase persist failed:", error?.message || error);
        }
      }
      // Also write to local file (fast reads within same process lifetime).
      try {
        await fs.promises.mkdir(path.dirname(rewardsStorePath), { recursive: true });
        const tempPath = `${rewardsStorePath}.tmp-${process.pid}-${Date.now()}`;
        await fs.promises.writeFile(tempPath, JSON.stringify(snapshot, null, 2), "utf8");
        await fs.promises.rename(tempPath, rewardsStorePath);
      } catch (error) {
        console.warn("[rewards-store] File persist failed:", error?.message || error);
      }
    });
  return persistQueue;
}

async function appendRewardEvent(event) {
  await ensureLoaded();
  const stableId = toSafeString(event?.id, 80);
  if (stableId) {
    const existing = store.rewardEvents.find((item) => item.id === stableId);
    if (existing) {
      return existing;
    }
  }
  const item = {
    id: stableId || `reward:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    kind: toSafeString(event?.kind, 80),
    email: normalizeEmail(event?.email),
    actorEmail: normalizeEmail(event?.actorEmail),
    creditedEmail: normalizeEmail(event?.creditedEmail),
    code: sanitizePromoCode(event?.code),
    promoType: toSafeString(event?.promoType, 80),
    amountPaise: normalizePaise(event?.amountPaise),
    note: toSafeString(event?.note, 240),
    createdAt: toEpochMs(event?.createdAt) || Date.now()
  };
  store.rewardEvents.unshift(item);
  store.rewardEvents = store.rewardEvents.slice(0, MAX_REWARD_EVENTS);
  await persistStore();
  return item;
}

async function appendNotification(notification) {
  await ensureLoaded();
  const email = normalizeEmail(notification?.email);
  if (!email) {
    return null;
  }
  const dedupeKey = toSafeString(notification?.dedupeKey, 220);
  if (dedupeKey && store.notifications.some((item) => item.email === email && item.dedupeKey === dedupeKey)) {
    return null;
  }
  const item = {
    id: `notification:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    email,
    kind: toSafeString(notification?.kind, 80),
    title: toSafeString(notification?.title, 120),
    message: toSafeString(notification?.message, 360),
    actionTarget: toSafeString(notification?.actionTarget, 80),
    code: sanitizePromoCode(notification?.code),
    read: false,
    readAt: 0,
    createdAt: Date.now(),
    dedupeKey
  };
  store.notifications.unshift(item);
  store.notifications = trimNotificationsByEmail(store.notifications, MAX_NOTIFICATIONS_PER_EMAIL).slice(0, MAX_NOTIFICATIONS);
  await persistStore();
  return item;
}

/**
 * Returns notifications array trimmed so each email keeps at most
 * `perEmailLimit` entries (newest first by createdAt). Prevents one
 * noisy user (or promo broadcast fan-out) from evicting another
 * user's notifications under the global MAX_NOTIFICATIONS cap.
 *
 * @param {Array<object>} notifications
 * @param {number} perEmailLimit
 * @returns {Array<object>}
 */
function trimNotificationsByEmail(notifications, perEmailLimit) {
  const limit = Math.max(1, Math.round(Number(perEmailLimit) || 0));
  if (!Array.isArray(notifications) || notifications.length === 0 || limit <= 0) {
    return Array.isArray(notifications) ? notifications : [];
  }
  const counts = new Map();
  const out = [];
  for (const item of notifications) {
    const email = normalizeEmail(item?.email);
    if (!email) {
      continue;
    }
    const seen = counts.get(email) || 0;
    if (seen >= limit) {
      continue;
    }
    counts.set(email, seen + 1);
    out.push(item);
  }
  return out;
}

async function listKnownRewardRecipients() {
  const recipients = new Set();
  for (const email of Object.keys(store.bonusProfiles || {})) {
    const safeEmail = normalizeEmail(email);
    if (safeEmail) {
      recipients.add(safeEmail);
    }
  }
  for (const notification of store.notifications || []) {
    const safeEmail = normalizeEmail(notification?.email);
    if (safeEmail) {
      recipients.add(safeEmail);
    }
  }
  try {
    const known = await listKnownUsersFromPayments(5000);
    for (const user of known?.users || []) {
      const safeEmail = normalizeEmail(user?.email || user?.userId || user?.user_id);
      if (safeEmail) {
        recipients.add(safeEmail);
      }
    }
  } catch (_error) {
    return [...recipients];
  }
  return [...recipients];
}

async function listNotifications(email, limit = 30) {
  await ensureLoaded();
  const safeEmail = normalizeEmail(email);
  const safeLimit = Math.max(1, Math.min(50, Math.round(Number(limit) || 30)));
  return store.notifications
    .filter((item) => item.email === safeEmail)
    .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0))
    .slice(0, safeLimit);
}

async function markNotificationRead(email, id) {
  await ensureLoaded();
  const safeEmail = normalizeEmail(email);
  const safeId = toSafeString(id, 80);
  const notification = store.notifications.find((item) => item.email === safeEmail && item.id === safeId);
  if (!notification) {
    throw new Error("Notification not found.");
  }
  notification.read = true;
  notification.readAt = Date.now();
  await persistStore();
  return notification;
}

async function ensureJoiningBonusAvailableNotification(email) {
  await ensureLoaded();
  const safeEmail = normalizeEmail(email);
  if (!safeEmail) {
    throw new Error("Valid email is required.");
  }
  if (await isAdminEmail(safeEmail)) {
    return {
      available: false,
      skipped: true,
      reason: "admin_ineligible"
    };
  }

  const now = Date.now();
  const current = store.bonusProfiles[safeEmail] || {
    firstSeenAt: now,
    joiningClaimedAt: 0,
    joiningBonusPaise: JOINING_BONUS_PAISE,
    updatedAt: now
  };
  store.bonusProfiles[safeEmail] = {
    ...current,
    firstSeenAt: Math.max(0, Number(current.firstSeenAt || 0)) || now,
    joiningBonusPaise: Math.max(0, Number(current.joiningBonusPaise || 0)) || JOINING_BONUS_PAISE,
    updatedAt: now
  };

  if (Number(current.joiningClaimedAt || 0) > 0) {
    await persistStore();
    return {
      available: false,
      alreadyClaimed: true,
      amountPaise: Math.max(0, Number(current.joiningBonusPaise) || JOINING_BONUS_PAISE),
      claimedAt: Number(current.joiningClaimedAt) || 0
    };
  }

  const notification = await appendNotification({
    email: safeEmail,
    kind: "joining_bonus_available",
    title: "Welcome bonus ready",
    message: "Tap to open the bonus page and redeem your welcome credit. Wallet stays 0 until you claim it.",
    actionTarget: "bonus",
    dedupeKey: `joining-bonus-available:${safeEmail}`
  });
  await persistStore();
  return {
    available: true,
    alreadyClaimed: false,
    amountPaise: Math.max(0, Number(store.bonusProfiles[safeEmail].joiningBonusPaise) || JOINING_BONUS_PAISE),
    notified: Boolean(notification),
    notification: notification || null
  };
}

async function getRewardDashboard(email) {
  await ensureLoaded();
  const safeEmail = normalizeEmail(email);
  if (!safeEmail) {
    throw new Error("Valid email is required.");
  }
  const resolvedRole = await isAdminEmail(safeEmail) ? "admin" : "user";
  const billing = await getUserPlanState({ userId: safeEmail }).catch(() => null);
  const now = Date.now();
  const bonusProfile = store.bonusProfiles[safeEmail] || {
    firstSeenAt: now,
    joiningClaimedAt: 0,
    joiningBonusPaise: JOINING_BONUS_PAISE,
    updatedAt: now
  };
  store.bonusProfiles[safeEmail] = bonusProfile;

  const promoCodes = Object.values(store.promos)
    .map((promo) => normalizePromoRecord(promo, promo?.code))
    .filter(Boolean)
    .filter((promo) => resolvedRole === "admin" || !promo.assignedToEmail || promo.assignedToEmail === safeEmail)
    .map((promo) => {
      const usedByCurrentUser = promo.redemptions.some((entry) => entry.redeemerEmail === safeEmail);
      const creditedToCurrentUser = promo.redemptions.some((entry) => entry.creditedEmail === safeEmail);
      const usageLeft = Math.max(0, Number(promo.usageLimit || 1) - Number(promo.usedCount || 0));
      const expired = Number(promo.expiresAt || 0) > 0 && Number(promo.expiresAt || 0) <= now;
      const shareable = promo.type === "invite_bonus" && promo.assignedToEmail === safeEmail;
      const selfBlocked = promo.blockedSelfUse && promo.createdByEmail && promo.createdByEmail === safeEmail;
      return {
        code: promo.code,
        type: promo.type,
        active: promo.active === true,
        assignedToEmail: promo.assignedToEmail,
        createdByEmail: promo.createdByEmail,
        note: promo.note,
        rewardPaise: calculatePromoRewardPaise(promo),
        valuePaise: promo.valuePaise,
        percent: promo.percent,
        percentBasePaise: promo.percentBasePaise,
        maxRewardPaise: promo.maxRewardPaise,
        usageLimit: promo.usageLimit,
        usedCount: promo.usedCount,
        usageLeft,
        usedByCurrentUser,
        redeemedByCurrentUser: usedByCurrentUser,
        creditedToCurrentUser,
        shareable,
        blockedSelfUse: promo.blockedSelfUse !== false,
        expired,
        canRedeem: resolvedRole !== "admin" && promo.active && !expired && usageLeft > 0 && !usedByCurrentUser && !selfBlocked && !shareable,
        latestRedeemerEmail: promo.latestRedeemerEmail,
        latestCreditedEmail: promo.latestCreditedEmail,
        latestRedemptionAt: promo.latestRedemptionAt,
        createdAt: promo.createdAt,
        updatedAt: promo.updatedAt,
        expiresAt: promo.expiresAt
      };
    })
    .sort((left, right) => {
      if (left.canRedeem !== right.canRedeem) {
        return left.canRedeem ? -1 : 1;
      }
      return Number(right.updatedAt || 0) - Number(left.updatedAt || 0);
    });
  const promoHistory = store.rewardEvents
    .filter((entry) => {
      // Only show events where the user actually received something.
      // admin_create is an internal event — user sees the promo in their
      // offers list, not in history. History entry appears only after redeem.
      const kind = String(entry.kind || "").trim().toLowerCase();
      if (kind === "admin_create") {
        return false;
      }
      return entry.email === safeEmail || entry.creditedEmail === safeEmail || entry.actorEmail === safeEmail;
    })
    .slice(0, 40);

  await persistStore();

  // Determine joining bonus state using multiple sources of truth:
  // 1. bonusProfiles[email].joiningClaimedAt (primary, but can be lost on redeploy)
  // 2. rewardEvents with kind=joining_bonus (secondary)
  // 3. wallet processedPayments with joining_bonus:email:* key (ultimate, persisted in Supabase)
  const joiningClaimedFromProfile = Number(bonusProfile.joiningClaimedAt || 0) > 0;
  const joiningClaimedFromEvents = store.rewardEvents.some((ev) =>
    ev.email === safeEmail && String(ev.kind || "").toLowerCase() === "joining_bonus"
  );
  const joiningClaimedFromWallet = await hasJoiningBonusPayment(safeEmail).catch(() => false);
  const joiningAlreadyClaimed = joiningClaimedFromProfile || joiningClaimedFromEvents || joiningClaimedFromWallet;

  // Auto-repair bonusProfile if wallet proves the bonus was claimed but profile lost it.
  if (joiningAlreadyClaimed && !joiningClaimedFromProfile) {
    store.bonusProfiles[safeEmail] = {
      ...bonusProfile,
      joiningClaimedAt: bonusProfile.joiningClaimedAt || Date.now(),
      updatedAt: Date.now()
    };
    await persistStore();
  }

  return {
    billing,
    joiningBonus: {
      eligible: resolvedRole !== "admin" && !joiningAlreadyClaimed,
      claimed: joiningAlreadyClaimed,
      amountPaise: Math.max(0, Number(bonusProfile.joiningBonusPaise) || JOINING_BONUS_PAISE),
      claimedAt: Math.max(0, Number(bonusProfile.joiningClaimedAt) || 0)
    },
    promoCodes,
    promoHistory,
    serverTime: now
  };
}

async function claimJoiningBonus(email) {
  const safeEmail = normalizeEmail(email);
  if (!safeEmail) {
    throw new Error("Valid email is required.");
  }
  return withKeyedMutex(`claim-joining-bonus:${safeEmail}`, async () => {
    await ensureLoaded();
    if (await isAdminEmail(safeEmail)) {
      throw new Error("Admin accounts are not eligible for joining bonus.");
    }
    const now = Date.now();
    const current = store.bonusProfiles[safeEmail] || {
      firstSeenAt: now,
      joiningClaimedAt: 0,
      joiningBonusPaise: JOINING_BONUS_PAISE,
      updatedAt: now
    };
    if (Number(current.joiningClaimedAt || 0) > 0) {
      return {
        claimed: false,
        alreadyClaimed: true,
        amountPaise: Math.max(0, Number(current.joiningBonusPaise) || JOINING_BONUS_PAISE),
        claimedAt: Number(current.joiningClaimedAt) || 0
      };
    }
    // Secondary guard: if rewardEvents already has a joining_bonus entry for
    // this user (e.g. bonusProfiles was reset but the credit went through),
    // treat it as already claimed.
    const existingEvent = store.rewardEvents.find((ev) =>
      ev.email === safeEmail && String(ev.kind || "").toLowerCase() === "joining_bonus"
    );
    if (existingEvent) {
      // Repair the bonusProfile so future checks are fast.
      store.bonusProfiles[safeEmail] = {
        ...current,
        joiningClaimedAt: Number(existingEvent.createdAt) || now,
        joiningBonusPaise: Math.max(0, Number(existingEvent.amountPaise) || JOINING_BONUS_PAISE),
        updatedAt: now
      };
      await persistStore();
      return {
        claimed: false,
        alreadyClaimed: true,
        amountPaise: Math.max(0, Number(existingEvent.amountPaise) || JOINING_BONUS_PAISE),
        claimedAt: Number(existingEvent.createdAt) || now
      };
    }

    // Ultimate guard: check wallet processedPayments (persisted in Supabase,
    // survives all redeploys). If the wallet already has a joining_bonus
    // payment for this user, the bonus was credited — just repair the profile.
    const walletHasBonus = await hasJoiningBonusPayment(safeEmail).catch(() => false);
    if (walletHasBonus) {
      store.bonusProfiles[safeEmail] = {
        ...current,
        joiningClaimedAt: now,
        joiningBonusPaise: JOINING_BONUS_PAISE,
        updatedAt: now
      };
      await persistStore();
      return {
        claimed: false,
        alreadyClaimed: true,
        amountPaise: JOINING_BONUS_PAISE,
        claimedAt: now
      };
    }

    // Use a paymentId that includes the bonus profile's firstSeenAt so a
    // deleted-and-re-created user gets a fresh idempotency key. The admin
    // delete flow wipes bonusProfiles[email], so the next signup creates a
    // new firstSeenAt → new paymentId → wallet credit goes through. Without
    // this, the stale processedPayments[joining_bonus:<email>] entry from
    // any cached/replicated wallet store would silently mark the credit as
    // a duplicate and the user would be left with a zero balance.
    const rewardPaise = JOINING_BONUS_PAISE;
    const firstSeenAt = Math.max(0, Number(current.firstSeenAt) || now);
    const paymentId = `joining_bonus:${safeEmail}:${firstSeenAt}`;
    const credit = await creditWallet({
      userId: safeEmail,
      amountInr: rewardPaise / 100,
      paymentId,
      source: "joining_bonus"
    });
    if (!credit?.applied && String(credit?.reason || "") !== "duplicate_payment") {
      throw new Error("Unable to credit joining bonus.");
    }

    store.bonusProfiles[safeEmail] = {
      ...current,
      joiningClaimedAt: now,
      joiningBonusPaise: rewardPaise,
      updatedAt: now
    };
    for (const notification of store.notifications) {
      if (notification.email === safeEmail && notification.kind === "joining_bonus_available") {
        notification.read = true;
        notification.readAt = Math.max(0, Number(notification.readAt || 0)) || now;
      }
    }
    await appendRewardEvent({
      id: `joining_bonus:${safeEmail}`,
      kind: "joining_bonus",
      email: safeEmail,
      creditedEmail: safeEmail,
      amountPaise: rewardPaise,
      note: "Joining bonus redeemed",
      createdAt: now
    });
    await appendNotification({
      email: safeEmail,
      kind: "joining_bonus_claimed",
      title: "Welcome bonus credited",
      message: `Rs ${(rewardPaise / 100).toFixed(2)} welcome bonus credited to your wallet.`,
      actionTarget: "bonus",
      dedupeKey: `joining-bonus-claimed:${safeEmail}`
    });
    await persistStore();
    return {
      claimed: credit?.applied !== false,
      alreadyClaimed: false,
      amountPaise: rewardPaise,
      claimedAt: now
    };
  });
}

/**
 * Creates or updates one promo code.
 * @param {object} input
 * @param {string=} actorEmail
 * @returns {Promise<object>}
 */
async function upsertPromoCode(input, actorEmail = "") {
  await ensureLoaded();

  const type = normalizePromoType(input?.type);
  const safeActorEmail = normalizeEmail(actorEmail);
  const assignedToEmail = normalizeEmail(input?.assignedToEmail);
  const now = Date.now();
  let code = sanitizePromoCode(input?.code);

  if (type === "invite_bonus") {
    if (!assignedToEmail) {
      throw new Error("Invite bonus must be assigned to one user.");
    }
    if (!code) {
      const existingOwnerInvite = Object.values(store.promos)
        .map((entry) => normalizePromoRecord(entry, entry?.code))
        .find((entry) =>
          entry &&
          entry.type === "invite_bonus" &&
          entry.assignedToEmail === assignedToEmail &&
          entry.active === true &&
          Number(entry.usedCount || 0) < Number(entry.usageLimit || 1) &&
          (Number(entry.expiresAt || 0) === 0 || Number(entry.expiresAt || 0) > now)
        );
      code = existingOwnerInvite?.code || generateInviteCode(assignedToEmail);
    }
  }

  if (!code || code.length < 4) {
    throw new Error("Promo code must be at least 4 characters.");
  }

  const expiresAt = Math.max(0, toEpochMs(input?.expiresAt));
  if (expiresAt > 0 && expiresAt <= now) {
    throw new Error("Promo expiry must be in the future.");
  }

  const existing = normalizePromoRecord(store.promos[code], code);
  if (existing && Number(existing.usedCount || 0) > 0) {
    throw new Error("Promo already used. Create a new code instead of editing this one.");
  }

  let valuePaise = 0;
  let percent = 0;
  let percentBasePaise = 0;
  let maxRewardPaise = 0;
  if (type === "percent_wallet") {
    percent = Math.max(1, Math.min(95, Math.round(Number(input?.percent) || 0)));
    if (!percent) {
      throw new Error("Percent reward must be between 1 and 95.");
    }
    percentBasePaise = Math.max(100, Math.round(normalizeInr(input?.percentBaseInr) * 100));
    maxRewardPaise = Math.max(0, Math.round(normalizeInr(input?.maxRewardInr) * 100));
  } else {
    valuePaise = Math.max(100, Math.round(normalizeInr(input?.valueInr) * 100));
    if (valuePaise < 100) {
      throw new Error("Promo reward must be at least Rs 1.");
    }
  }

  const promo = normalizePromoRecord({
    ...(existing || {}),
    code,
    type,
    active: input?.active !== false,
    assignedToEmail,
    createdByEmail: safeActorEmail || existing?.createdByEmail,
    note: toSafeString(input?.note, 220),
    usageLimit: type === "invite_bonus"
      ? 1
      : Math.max(1, Math.min(MAX_PROMO_REDEMPTIONS, Math.round(Number(input?.usageLimit) || 1))),
    valuePaise,
    percent,
    percentBasePaise,
    maxRewardPaise,
    blockedSelfUse: input?.allowSelfUse ? false : true,
    redemptions: existing?.redemptions || [],
    usedCount: existing?.usedCount || 0,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    expiresAt
  }, code);

  if (!promo) {
    throw new Error("Unable to save promo configuration.");
  }

  store.promos[promo.code] = promo;
  await persistStore();
  // Use the promo's createdAt (set once when the code is first created) so
  // re-upserting the same code does not generate duplicate "promo assigned"
  // notifications. updatedAt would change on every save and break dedupe.
  const promoAssignmentKey = String(Math.max(0, Number(promo?.createdAt || now)) || now);

  await appendRewardEvent({
    kind: "admin_create",
    email: assignedToEmail || safeActorEmail || "admin@faizanai.local",
    creditedEmail: assignedToEmail || safeActorEmail || "admin@faizanai.local",
    actorEmail: safeActorEmail,
    code: promo.code,
    promoType: promo.type,
    amountPaise: calculatePromoRewardPaise(promo),
    note: `Promo ${promo.code} created`
  });

  if (assignedToEmail && !(await isAdminEmail(assignedToEmail))) {
    const inviteMessage = promo.type === "invite_bonus"
      ? `Your invite code ${promo.code} is ready. Share it with a new user to earn the reward.`
      : `A new promo code ${promo.code} is available on your bonus page.`;
    await appendNotification({
      email: assignedToEmail,
      kind: promo.type === "invite_bonus" ? "invite_code_ready" : "promo_assigned",
      title: promo.type === "invite_bonus" ? "Invite code assigned" : "New promo code assigned",
      message: inviteMessage,
      actionTarget: "bonus",
      code: promo.code,
      dedupeKey: `promo-assigned:${assignedToEmail}:${promo.code}:${promoAssignmentKey}`
    });
  } else if (!assignedToEmail && promo.type !== "invite_bonus") {
    const recipients = await listKnownRewardRecipients();
    for (const recipient of recipients) {
      if (!recipient || (await isAdminEmail(recipient))) {
        continue;
      }

      await appendNotification({
        email: recipient,
        kind: "promo_assigned",
        title: "New promo code assigned",
        message: `A new promo code ${promo.code} is available on your bonus page.`,
        actionTarget: "bonus",
        code: promo.code,
        dedupeKey: `promo-assigned:${recipient}:${promo.code}:${promoAssignmentKey}`
      });
    }
  }

  return promo;
}

/**
 * Updates promo active state.
 * @param {string} rawCode
 * @param {boolean} active
 * @returns {Promise<object>}
 */
async function setPromoCodeStatus(rawCode, active) {
  await ensureLoaded();
  const code = sanitizePromoCode(rawCode);
  if (!code) {
    throw new Error("Promo code is required.");
  }

  const promo = normalizePromoRecord(store.promos[code], code);
  if (!promo) {
    throw new Error("Promo code not found.");
  }

  if (Boolean(active) && Number(promo.usedCount || 0) >= Number(promo.usageLimit || 1)) {
    throw new Error("Used promo cannot be reactivated.");
  }

  promo.active = Boolean(active);
  promo.updatedAt = Date.now();
  store.promos[code] = promo;
  await persistStore();
  return promo;
}

/**
 * Removes all promo code records.
 * @returns {Promise<{removedCount:number,clearedAt:number}>}
 */
async function clearAllPromoCodes() {
  await ensureLoaded();

  const removedCount = Object.keys(store.promos || {}).length;
  store.promos = {};
  const clearedAt = Date.now();
  await persistStore();

  await appendRewardEvent({
    kind: "admin_clear_promos",
    email: "admin@faizanai.local",
    creditedEmail: "admin@faizanai.local",
    promoType: "fixed_wallet",
    amountPaise: 0,
    note: `Cleared ${removedCount} promo code(s)`,
    createdAt: clearedAt
  }).catch(() => undefined);

  return {
    removedCount,
    clearedAt
  };
}

async function deleteRewardRecordsForEmail(email) {
  await ensureLoaded();
  const safeEmail = normalizeEmail(email);
  if (!safeEmail) {
    return {
      ok: false,
      email: "",
      removedPromos: 0,
      removedNotifications: 0,
      removedRewardEvents: 0,
      removedBonusProfile: false
    };
  }

  const hadBonusProfile = Boolean(store.bonusProfiles?.[safeEmail]);
  delete store.bonusProfiles[safeEmail];

  const originalPromoCodes = Object.keys(store.promos || {});
  for (const code of originalPromoCodes) {
    const promo = store.promos[code];
    const assignedToEmail = normalizeEmail(promo?.assignedToEmail);
    const createdByEmail = normalizeEmail(promo?.createdByEmail);
    const latestRedeemerEmail = normalizeEmail(promo?.latestRedeemerEmail);
    const latestCreditedEmail = normalizeEmail(promo?.latestCreditedEmail);
    const redemptions = Array.isArray(promo?.redemptions) ? promo.redemptions : [];
    const hasRedemption = redemptions.some((entry) => {
      const redeemerEmail = normalizeEmail(entry?.redeemerEmail || entry?.email);
      const creditedEmail = normalizeEmail(entry?.creditedEmail || entry?.email || redeemerEmail);
      return redeemerEmail === safeEmail || creditedEmail === safeEmail;
    });
    if (
      assignedToEmail === safeEmail ||
      createdByEmail === safeEmail ||
      latestRedeemerEmail === safeEmail ||
      latestCreditedEmail === safeEmail ||
      hasRedemption
    ) {
      delete store.promos[code];
    }
  }

  const beforeNotifications = Array.isArray(store.notifications) ? store.notifications.length : 0;
  store.notifications = (Array.isArray(store.notifications) ? store.notifications : []).filter(
    (item) => normalizeEmail(item?.email) !== safeEmail
  );

  const beforeRewardEvents = Array.isArray(store.rewardEvents) ? store.rewardEvents.length : 0;
  store.rewardEvents = (Array.isArray(store.rewardEvents) ? store.rewardEvents : []).filter((event) => {
    const emails = [
      normalizeEmail(event?.email),
      normalizeEmail(event?.actorEmail),
      normalizeEmail(event?.creditedEmail)
    ];
    return !emails.includes(safeEmail);
  });

  if (store.notificationReceipts && typeof store.notificationReceipts === "object") {
    delete store.notificationReceipts[safeEmail];
  }

  store.updatedAt = Date.now();
  await persistStore();

  return {
    ok: true,
    email: safeEmail,
    removedPromos: originalPromoCodes.length - Object.keys(store.promos || {}).length,
    removedNotifications: beforeNotifications - store.notifications.length,
    removedRewardEvents: beforeRewardEvents - store.rewardEvents.length,
    removedBonusProfile: hadBonusProfile
  };
}

/**
 * Returns admin-friendly promo list.
 * @returns {Promise<Array<object>>}
 */
async function listPromosForAdmin() {
  await ensureLoaded();
  return Object.values(store.promos)
    .map((promo) => normalizePromoRecord(promo, promo?.code))
    .filter(Boolean)
    .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0))
    .map((promo) => ({
      code: promo.code,
      type: promo.type,
      active: promo.active === true,
      assignedToEmail: promo.assignedToEmail,
      createdByEmail: promo.createdByEmail,
      note: promo.note,
      valuePaise: promo.valuePaise,
      percent: promo.percent,
      percentBasePaise: promo.percentBasePaise,
      maxRewardPaise: promo.maxRewardPaise,
      rewardPaise: calculatePromoRewardPaise(promo),
      usageLimit: promo.usageLimit,
      usedCount: promo.usedCount,
      blockedSelfUse: promo.blockedSelfUse !== false,
      createdAt: promo.createdAt,
      updatedAt: promo.updatedAt,
      expiresAt: promo.expiresAt,
      latestRedeemerEmail: promo.latestRedeemerEmail,
      latestCreditedEmail: promo.latestCreditedEmail,
      latestRedemptionAt: promo.latestRedemptionAt,
      redemptions: Array.isArray(promo.redemptions) ? promo.redemptions.slice(0, 20) : []
    }));
}

/**
 * Redeems promo code for one email.
 * @param {string} email
 * @param {string} rawCode
 * @returns {Promise<object>}
 */
async function redeemPromoCode(email, rawCode) {
  const safeEmail = normalizeEmail(email);
  if (!safeEmail) {
    throw new Error("Valid email is required.");
  }
  const code = sanitizePromoCode(rawCode);
  if (!code || code.length < 4) {
    throw new Error("Enter a valid promo code.");
  }
  return withKeyedMutex(`redeem-promo:${code}`, () => redeemPromoCodeImpl(safeEmail, code));
}

async function redeemPromoCodeImpl(safeEmail, code) {
  await ensureLoaded();

  const now = Date.now();
  const promo = normalizePromoRecord(store.promos[code], code);
  if (!promo) {
    throw new Error("Promo code not found.");
  }
  if (!promo.active) {
    throw new Error("Promo code not found.");
  }
  if (Number(promo.expiresAt || 0) > 0 && Number(promo.expiresAt) <= now) {
    promo.active = false;
    promo.updatedAt = now;
    store.promos[code] = promo;
    await persistStore();
    throw new Error("This promo code has expired.");
  }
  if (Number(promo.usedCount || 0) >= Number(promo.usageLimit || 1)) {
    promo.active = false;
    promo.updatedAt = now;
    store.promos[code] = promo;
    await persistStore();
    throw new Error("Promo code usage limit is reached.");
  }
  if (
    promo.blockedSelfUse &&
    promo.createdByEmail &&
    promo.createdByEmail === safeEmail
  ) {
    throw new Error("You cannot redeem your own promo code.");
  }

  const rewardPaise = calculatePromoRewardPaise(promo);
  const promoInstanceKey = getPromoInstanceKey(promo, now);
  let creditedEmail = safeEmail;
  let paymentId = `promo_reward:${code}:${promoInstanceKey}:${safeEmail}`;
  let walletSource = `promo_reward:${code}:${promoInstanceKey}`;
  let note = `Promo ${code} redeemed`;
  let notificationTitle = "Promo redeemed";
  let notificationMessage = `Promo ${code} has been credited to your wallet.`;
  let resultMode = "redeemer";

  const redeemedByCurrentUser = Array.isArray(promo.redemptions)
    ? promo.redemptions.some((entry) => entry.redeemerEmail === safeEmail)
    : false;
  if (redeemedByCurrentUser) {
    throw new Error("Promo code already used on this account.");
  }

  if (promo.type === "invite_bonus") {
    if (!promo.assignedToEmail) {
      throw new Error("Invite code owner is missing.");
    }
    if (promo.assignedToEmail === safeEmail) {
      throw new Error("You cannot redeem your own invite code.");
    }

    creditedEmail = promo.assignedToEmail;
    paymentId = `invite_reward:${code}:${promoInstanceKey}:${safeEmail}`;
    walletSource = `invite_reward:${code}:${promoInstanceKey}`;
    note = `${safeEmail} used invite code ${code}`;
    notificationTitle = "Invite reward earned";
    notificationMessage = `${safeEmail} used your invite code ${code}. Reward credited to wallet.`;
    resultMode = "invite_owner";
  } else if (promo.assignedToEmail && promo.assignedToEmail !== safeEmail) {
    throw new Error("Promo code not found.");
  }

  const credit = await creditWallet({
    userId: creditedEmail,
    amountInr: rewardPaise / 100,
    paymentId,
    source: walletSource
  });

  if (!credit?.applied && String(credit?.reason || "") === "duplicate_payment") {
    throw new Error("Promo code already used on this account.");
  }
  if (!credit?.applied) {
    throw new Error("Unable to credit reward wallet.");
  }

  promo.redemptions = Array.isArray(promo.redemptions) ? promo.redemptions : [];
  promo.redemptions.unshift({
    redeemerEmail: safeEmail,
    creditedEmail,
    amountPaise: rewardPaise,
    createdAt: now
  });
  promo.redemptions = promo.redemptions.slice(0, MAX_PROMO_REDEMPTIONS);
  promo.usedCount = Math.max(Number(promo.usedCount || 0) + 1, promo.redemptions.length);
  promo.latestRedeemerEmail = safeEmail;
  promo.latestCreditedEmail = creditedEmail;
  promo.latestRedemptionAt = now;
  promo.updatedAt = now;
  if (Number(promo.usedCount || 0) >= Number(promo.usageLimit || 1)) {
    promo.active = false;
  }
  store.promos[code] = promo;
  await persistStore();

  await appendRewardEvent({
    kind: promo.type === "invite_bonus" ? "invite_reward" : "promo_redeem",
    email: creditedEmail,
    actorEmail: safeEmail,
    creditedEmail,
    code,
    promoType: promo.type,
    amountPaise: rewardPaise,
    note
  });

  if (!(await isAdminEmail(creditedEmail))) {
    await appendNotification({
      email: creditedEmail,
      kind: promo.type === "invite_bonus" ? "invite_reward" : "promo_redeemed",
      title: notificationTitle,
      message: notificationMessage,
      actionTarget: "bonus",
      code,
      dedupeKey: promo.type === "invite_bonus"
        ? `invite-reward:${creditedEmail}:${code}:${safeEmail}:${promoInstanceKey}`
        : `promo-redeemed:${safeEmail}:${code}:${promoInstanceKey}`
    });
  }

  if (promo.type === "invite_bonus" && !(await isAdminEmail(safeEmail))) {
    await appendNotification({
      email: safeEmail,
      kind: "invite_code_applied",
      title: "Invite code accepted",
      message: `Invite code ${code} was accepted successfully.`,
      actionTarget: "bonus",
      code,
      dedupeKey: `invite-applied:${safeEmail}:${code}:${promoInstanceKey}`
    });
  }

  return {
    code,
    amountPaise: rewardPaise,
    creditedEmail,
    rewardMode: resultMode,
    promoInstanceKey,
    promo: {
      code: promo.code,
      type: promo.type,
      usedCount: promo.usedCount,
      usageLimit: promo.usageLimit,
      active: promo.active === true
    }
  };
}

/**
 * Records an admin wallet credit notification/event.
 * @param {{email:string,amountInr:number,note?:string,actorEmail?:string}} payload
 * @returns {Promise<void>}
 */
async function recordAdminWalletCredit(payload) {
  await ensureLoaded();

  const email = normalizeEmail(payload?.email);
  const amountInr = normalizeInr(payload?.amountInr);
  const amountPaise = Math.round(amountInr * 100);
  if (!email || amountPaise <= 0) {
    return;
  }

  const actorEmail = normalizeEmail(payload?.actorEmail);
  const note = toSafeString(
    payload?.note || `Wallet credited by admin ${actorEmail || "admin"}`,
    120
  ) || `Wallet credited by admin ${actorEmail || "admin"}`;

  await appendRewardEvent({
    kind: "admin_wallet_credit",
    email,
    actorEmail,
    creditedEmail: email,
    amountPaise,
    note
  });

  if (!(await isAdminEmail(email))) {
    await appendNotification({
      email,
      kind: "wallet_credit",
      title: "Wallet bonus added",
      message: `${note} has been credited to your wallet.`,
      actionTarget: "billing",
      dedupeKey: `wallet-credit:${email}:${amountPaise}:${note}`
    });
  }
}

module.exports = {
  JOINING_BONUS_PAISE,
  getRewardDashboard,
  ensureJoiningBonusAvailableNotification,
  claimJoiningBonus,
  upsertPromoCode,
  setPromoCodeStatus,
  clearAllPromoCodes,
  listPromosForAdmin,
  redeemPromoCode,
  listNotifications,
  markNotificationRead,
  recordAdminWalletCredit,
  deleteRewardRecordsForEmail
};
