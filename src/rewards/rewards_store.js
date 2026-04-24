"use strict";

const fs = require("fs");
const path = require("path");

const { getUserPlanState, listKnownUsersFromPayments } = require("../payments/supabase_store");
const { creditWallet } = require("../payments/wallet_store");
const { resolveStorePath } = require("../storage/store_path");

const JOINING_BONUS_PAISE = 1500;
const MAX_NOTIFICATIONS = 6000;
const MAX_REWARD_EVENTS = 6000;
const MAX_PROMO_REDEMPTIONS = 500;
const rewardsStorePath = resolveStorePath(process.env.REWARDS_STORE_PATH, "rewards.json");

let store = {
  promos: {},
  bonusProfiles: {},
  notifications: [],
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
  const prefix = buildInviteSeed(ownerEmail);
  let attempt = 0;
  while (attempt < 1000) {
    const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
    const candidate = sanitizePromoCode(`INV-${prefix}-${suffix}`);
    if (candidate && !store.promos[candidate]) {
      return candidate;
    }
    attempt += 1;
  }
  return sanitizePromoCode(`INV-${prefix}-${Date.now().toString(36).slice(-6).toUpperCase()}`);
}

/**
 * Normalizes one redemption entry.
 * @param {any} value
 * @returns {object|null}
 */
function normalizePromoRedemption(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const redeemerEmail = normalizeEmail(value.redeemerEmail || value.email);
  const creditedEmail = normalizeEmail(value.creditedEmail || value.ownerEmail || value.email);
  if (!redeemerEmail && !creditedEmail) {
    return null;
  }

  return {
    redeemerEmail,
    creditedEmail,
    amountPaise: Math.max(0, normalizePaise(value.amountPaise)),
    createdAt: toEpochMs(value.createdAt) || Date.now()
  };
}

/**
 * Normalizes one bonus profile row.
 * @param {any} value
 * @returns {object}
 */
function normalizeBonusProfile(value) {
  return {
    firstSeenAt: toEpochMs(value?.firstSeenAt) || Date.now(),
    joiningClaimedAt: Math.max(0, toEpochMs(value?.joiningClaimedAt)),
    joiningBonusPaise: Math.max(0, normalizePaise(value?.joiningBonusPaise)) || JOINING_BONUS_PAISE,
    updatedAt: toEpochMs(value?.updatedAt) || Date.now()
  };
}

/**
 * Normalizes one notification entry.
 * @param {any} value
 * @returns {object|null}
 */
function normalizeNotification(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const email = normalizeEmail(value.email);
  if (!email) {
    return null;
  }

  return {
    id: toSafeString(value.id, 80) || `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    email,
    kind: toSafeString(value.kind, 40).toLowerCase() || "info",
    title: toSafeString(value.title, 120) || "Update",
    message: toSafeString(value.message, 260),
    actionTarget: toSafeString(value.actionTarget, 40).toLowerCase() || "bonus",
    actionUrl: toSafeString(value.actionUrl, 240),
    code: sanitizePromoCode(value.code),
    metadata: value.metadata && typeof value.metadata === "object" ? value.metadata : {},
    dedupeKey: toSafeString(value.dedupeKey, 120),
    readAt: Math.max(0, toEpochMs(value.readAt)),
    createdAt: toEpochMs(value.createdAt) || Date.now()
  };
}

/**
 * Normalizes one reward event entry.
 * @param {any} value
 * @returns {object|null}
 */
function normalizeRewardEvent(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const email = normalizeEmail(value.email);
  if (!email) {
    return null;
  }

  return {
    id: toSafeString(value.id, 80) || `reward-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: toSafeString(value.kind, 40).toLowerCase() || "reward",
    email,
    actorEmail: normalizeEmail(value.actorEmail),
    creditedEmail: normalizeEmail(value.creditedEmail || value.email),
    code: sanitizePromoCode(value.code),
    promoType:
      String(value.promoType || "").trim().toLowerCase() === "joining_bonus"
        ? "joining_bonus"
        : normalizePromoType(value.promoType),
    amountPaise: Math.max(0, normalizePaise(value.amountPaise)),
    note: toSafeString(value.note, 220),
    createdAt: toEpochMs(value.createdAt) || Date.now()
  };
}

/**
 * Normalizes one promo record.
 * @param {any} value
 * @param {string=} fallbackCode
 * @returns {object|null}
 */
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
  const usageLimit = type === "invite_bonus"
    ? 1
    : Math.max(1, Math.min(5000, Math.round(Number(value.usageLimit) || 1)));
  const expiresAt = Math.max(0, toEpochMs(value.expiresAt));

  const redemptions = (Array.isArray(value.redemptions) ? value.redemptions : [])
    .map((entry) => normalizePromoRedemption(entry))
    .filter(Boolean)
    .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0))
    .slice(0, MAX_PROMO_REDEMPTIONS);

  const usedCount = Math.max(
    redemptions.length,
    Math.max(0, Math.round(Number(value.usedCount) || 0))
  );

  const promo = {
    code,
    type,
    active: normalizeBoolean(value.active, true),
    assignedToEmail: normalizeEmail(value.assignedToEmail),
    createdByEmail: normalizeEmail(value.createdByEmail),
    note: toSafeString(value.note, 220),
    valuePaise: type === "percent_wallet" ? 0 : Math.max(100, normalizePaise(value.valuePaise)),
    percent: type === "percent_wallet" ? Math.max(1, Math.min(95, Math.round(Number(value.percent) || 0))) : 0,
    percentBasePaise: type === "percent_wallet" ? Math.max(100, normalizePaise(value.percentBasePaise)) : 0,
    maxRewardPaise: type === "percent_wallet" ? Math.max(0, normalizePaise(value.maxRewardPaise)) : 0,
    usageLimit,
    usedCount: Math.min(usageLimit, usedCount),
    blockedSelfUse: normalizeBoolean(value.blockedSelfUse, true),
    redemptions,
    latestRedeemerEmail: normalizeEmail(value.latestRedeemerEmail || redemptions[0]?.redeemerEmail),
    latestCreditedEmail: normalizeEmail(value.latestCreditedEmail || redemptions[0]?.creditedEmail),
    latestRedemptionAt: Math.max(0, toEpochMs(value.latestRedemptionAt) || redemptions[0]?.createdAt || 0),
    createdAt: toEpochMs(value.createdAt) || now,
    updatedAt: toEpochMs(value.updatedAt) || now,
    expiresAt
  };

  if (promo.type === "invite_bonus" && !promo.assignedToEmail) {
    return null;
  }

  const expired = promo.expiresAt > 0 && promo.expiresAt <= now;
  if (expired || promo.usedCount >= promo.usageLimit) {
    promo.active = false;
  }

  return promo;
}

/**
 * Normalizes full store payload.
 * @param {any} raw
 * @returns {object}
 */
function normalizeStore(raw) {
  const promos = {};
  const bonusProfiles = {};

  for (const [rawCode, value] of Object.entries(raw?.promos && typeof raw.promos === "object" ? raw.promos : {})) {
    const promo = normalizePromoRecord(value, rawCode);
    if (promo) {
      promos[promo.code] = promo;
    }
  }

  for (const [rawEmail, value] of Object.entries(raw?.bonusProfiles && typeof raw.bonusProfiles === "object" ? raw.bonusProfiles : {})) {
    const email = normalizeEmail(rawEmail);
    if (!email) {
      continue;
    }
    bonusProfiles[email] = normalizeBonusProfile(value);
  }

  const notifications = (Array.isArray(raw?.notifications) ? raw.notifications : [])
    .map((entry) => normalizeNotification(entry))
    .filter(Boolean)
    .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0))
    .slice(0, MAX_NOTIFICATIONS);

  const rewardEvents = (Array.isArray(raw?.rewardEvents) ? raw.rewardEvents : [])
    .map((entry) => normalizeRewardEvent(entry))
    .filter(Boolean)
    .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0))
    .slice(0, MAX_REWARD_EVENTS);

  return {
    promos,
    bonusProfiles,
    notifications,
    rewardEvents,
    updatedAt: toEpochMs(raw?.updatedAt) || Date.now()
  };
}

/**
 * Ensures store is loaded from disk once.
 */
function ensureLoaded() {
  if (initialized) {
    return;
  }

  initialized = true;
  try {
    if (!fs.existsSync(rewardsStorePath)) {
      return;
    }

    const content = fs.readFileSync(rewardsStorePath, "utf8");
    if (!content.trim()) {
      return;
    }

    store = normalizeStore(JSON.parse(content));
  } catch (error) {
    console.warn("[rewards-store] Failed to load store:", error?.message || error);
    store = normalizeStore({});
  }
}

/**
 * Persists in-memory store to disk serially.
 * @returns {Promise<void>}
 */
function persistStore() {
  store.updatedAt = Date.now();
  const snapshot = JSON.stringify(store, null, 2);
  persistQueue = persistQueue
    .catch(() => undefined)
    .then(async () => {
      await fs.promises.mkdir(path.dirname(rewardsStorePath), { recursive: true });
      await fs.promises.writeFile(rewardsStorePath, snapshot, "utf8");
    })
    .catch((error) => {
      console.error("[rewards-store] Failed to persist store:", error?.message || error);
      throw error;
    });

  return persistQueue;
}

/**
 * Appends one reward notification with optional dedupe key.
 * @param {object} value
 * @returns {Promise<object|null>}
 */
async function appendNotification(value) {
  ensureLoaded();

  const notification = normalizeNotification({
    ...value,
    createdAt: value?.createdAt || Date.now()
  });
  if (!notification) {
    return null;
  }

  if (notification.dedupeKey) {
    const existing = store.notifications.find((entry) =>
      entry.email === notification.email &&
      entry.dedupeKey === notification.dedupeKey &&
      Number(entry.readAt || 0) === 0
    );
    if (existing) {
      return existing;
    }
  }

  store.notifications.unshift(notification);
  store.notifications = store.notifications
    .map((entry) => normalizeNotification(entry))
    .filter(Boolean)
    .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0))
    .slice(0, MAX_NOTIFICATIONS);
  await persistStore();
  return notification;
}

/**
 * Marks one notification as read for one email.
 * @param {string} email
 * @param {string} notificationId
 * @returns {Promise<object|null>}
 */
async function markNotificationRead(email, notificationId) {
  ensureLoaded();
  const safeEmail = normalizeEmail(email);
  const safeId = toSafeString(notificationId, 80);
  if (!safeEmail || !safeId) {
    return null;
  }

  let updated = null;
  store.notifications = store.notifications.map((entry) => {
    if (entry.email !== safeEmail || entry.id !== safeId) {
      return entry;
    }
    updated = normalizeNotification({
      ...entry,
      readAt: entry.readAt || Date.now()
    });
    return updated;
  });

  if (updated) {
    await persistStore();
  }
  return updated;
}

/**
 * Returns notification list for one user.
 * @param {string} email
 * @param {number=} limit
 * @returns {Promise<Array<object>>}
 */
async function listNotifications(email, limit = 30) {
  ensureLoaded();
  const safeEmail = normalizeEmail(email);
  if (!safeEmail) {
    return [];
  }
  if (await isAdminEmail(safeEmail)) {
    return [];
  }

  await ensureJoiningBonusNotification(safeEmail);
  const safeLimit = Math.max(1, Math.min(100, Math.round(Number(limit) || 30)));
  return store.notifications
    .filter((entry) => entry.email === safeEmail)
    .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0))
    .slice(0, safeLimit)
    .map((entry) => ({
      ...entry,
      unread: Number(entry.readAt || 0) === 0
    }));
}

/**
 * Appends one reward event.
 * @param {object} value
 * @returns {Promise<object|null>}
 */
async function appendRewardEvent(value) {
  ensureLoaded();

  const event = normalizeRewardEvent({
    ...value,
    createdAt: value?.createdAt || Date.now()
  });
  if (!event) {
    return null;
  }

  store.rewardEvents.unshift(event);
  store.rewardEvents = store.rewardEvents
    .map((entry) => normalizeRewardEvent(entry))
    .filter(Boolean)
    .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0))
    .slice(0, MAX_REWARD_EVENTS);
  await persistStore();
  return event;
}

/**
 * Returns existing or freshly created bonus profile.
 * @param {string} email
 * @returns {object}
 */
function ensureBonusProfile(email) {
  const safeEmail = normalizeEmail(email);
  if (!safeEmail) {
    return normalizeBonusProfile({});
  }

  if (!store.bonusProfiles[safeEmail]) {
    store.bonusProfiles[safeEmail] = normalizeBonusProfile({
      firstSeenAt: Date.now()
    });
  }

  store.bonusProfiles[safeEmail] = normalizeBonusProfile(store.bonusProfiles[safeEmail]);
  return store.bonusProfiles[safeEmail];
}

/**
 * Returns known reward recipient emails from local store and backend registry.
 * @returns {Promise<Array<string>>}
 */
async function listKnownRewardRecipients() {
  ensureLoaded();

  const recipients = new Set(
    Object.keys(store.bonusProfiles || {})
      .map((entry) => normalizeEmail(entry))
      .filter(Boolean)
  );

  try {
    const listed = await listKnownUsersFromPayments();
    const users = Array.isArray(listed?.users) ? listed.users : [];
    users.forEach((user) => {
      const email = normalizeEmail(user?.email || user?.userId || user?.user_id);
      if (email) {
        recipients.add(email);
      }
    });
  } catch (_error) {
    // Non-blocking: keep local recipient set.
  }

  return Array.from(recipients);
}

/**
 * Ensures eligible user has a joining-bonus notification.
 * @param {string} email
 * @returns {Promise<void>}
 */
async function ensureJoiningBonusNotification(email) {
  const safeEmail = normalizeEmail(email);
  if (!safeEmail) {
    return;
  }
  if (await isAdminEmail(safeEmail)) {
    return;
  }

  const profile = ensureBonusProfile(safeEmail);
  if (Number(profile.joiningClaimedAt || 0) > 0) {
    return;
  }

  const dedupeKey = `joining_bonus_available:${safeEmail}`;
  const existing = store.notifications.find((entry) =>
    entry.email === safeEmail && entry.dedupeKey === dedupeKey
  );
  if (existing) {
    return;
  }

  await appendNotification({
    email: safeEmail,
    kind: "joining_bonus_available",
    title: "Joining bonus available",
    message: "Claim your welcome reward from the bonus page.",
    actionTarget: "bonus",
    dedupeKey
  });
}

/**
 * Returns current reward dashboard for one user.
 * @param {string} email
 * @returns {Promise<object>}
 */
async function getRewardDashboard(email) {
  ensureLoaded();
  const safeEmail = normalizeEmail(email);
  if (!safeEmail) {
    throw new Error("Valid email is required.");
  }

  const adminAccount = await isAdminEmail(safeEmail);
  if (!adminAccount) {
    await ensureJoiningBonusNotification(safeEmail);
  }
  const bonusProfile = ensureBonusProfile(safeEmail);
  const now = Date.now();

  const promoCodes = Object.values(store.promos)
    .filter(Boolean)
    .map((promo) => normalizePromoRecord(promo, promo.code))
    .filter(Boolean)
    .filter((promo) => {
      if (!promo.assignedToEmail) {
        return true;
      }
      return promo.assignedToEmail === safeEmail;
    })
    .map((promo) => {
      const rewardPaise = calculatePromoRewardPaise(promo);
      const usageLeft = Math.max(0, Number(promo.usageLimit || 1) - Number(promo.usedCount || 0));
      const expired = Number(promo.expiresAt || 0) > 0 && Number(promo.expiresAt) <= now;
      const redeemedByCurrentUser = Array.isArray(promo.redemptions)
        ? promo.redemptions.some((entry) => entry.redeemerEmail === safeEmail)
        : false;
      const creditedToCurrentUser = Array.isArray(promo.redemptions)
        ? promo.redemptions.some((entry) => entry.creditedEmail === safeEmail)
        : false;
      const shareable = promo.type === "invite_bonus" && promo.assignedToEmail === safeEmail;
      const selfBlocked = Boolean(
        promo.blockedSelfUse &&
        promo.createdByEmail &&
        promo.createdByEmail === safeEmail
      );
      const canRedeem =
        promo.active === true &&
        !expired &&
        usageLeft > 0 &&
        !selfBlocked &&
        !redeemedByCurrentUser &&
        (!promo.assignedToEmail || promo.assignedToEmail === safeEmail) &&
        (!shareable);

      return {
        code: promo.code,
        type: promo.type,
        active: promo.active === true,
        assignedToEmail: promo.assignedToEmail,
        createdByEmail: promo.createdByEmail,
        note: promo.note,
        rewardPaise,
        valuePaise: promo.valuePaise,
        percent: promo.percent,
        percentBasePaise: promo.percentBasePaise,
        maxRewardPaise: promo.maxRewardPaise,
        usageLimit: promo.usageLimit,
        usedCount: promo.usedCount,
        usageLeft,
        expired,
        canRedeem,
        shareable,
        redeemedByCurrentUser,
        creditedToCurrentUser,
        latestRedeemerEmail: promo.latestRedeemerEmail,
        latestCreditedEmail: promo.latestCreditedEmail,
        latestRedemptionAt: promo.latestRedemptionAt,
        createdAt: promo.createdAt,
        updatedAt: promo.updatedAt,
        expiresAt: promo.expiresAt
      };
    })
    .sort((left, right) => {
      if (left.shareable !== right.shareable) {
        return left.shareable ? -1 : 1;
      }
      if (left.canRedeem !== right.canRedeem) {
        return left.canRedeem ? -1 : 1;
      }
      return Number(right.updatedAt || 0) - Number(left.updatedAt || 0);
    });

  const promoHistory = store.rewardEvents
    .filter((entry) =>
      entry.email === safeEmail ||
      entry.creditedEmail === safeEmail ||
      entry.actorEmail === safeEmail
    )
    .slice(0, 40);

  return {
    joiningBonus: {
      eligible: adminAccount ? false : Number(bonusProfile.joiningClaimedAt || 0) === 0,
      claimed: adminAccount ? false : Number(bonusProfile.joiningClaimedAt || 0) > 0,
      amountPaise: Math.max(0, Number(bonusProfile.joiningBonusPaise) || JOINING_BONUS_PAISE),
      claimedAt: adminAccount ? 0 : Math.max(0, Number(bonusProfile.joiningClaimedAt) || 0)
    },
    promoCodes,
    promoHistory,
    unreadNotificationCount: adminAccount
      ? 0
      : store.notifications.filter((entry) =>
        entry.email === safeEmail && Number(entry.readAt || 0) === 0
      ).length,
    serverTime: now
  };
}

/**
 * Claims the one-time joining bonus.
 * @param {string} email
 * @returns {Promise<object>}
 */
async function claimJoiningBonus(email) {
  ensureLoaded();
  const safeEmail = normalizeEmail(email);
  if (!safeEmail) {
    throw new Error("Valid email is required.");
  }
  if (await isAdminEmail(safeEmail)) {
    throw new Error("Admin accounts cannot claim joining bonus.");
  }

  const profile = ensureBonusProfile(safeEmail);
  if (Number(profile.joiningClaimedAt || 0) > 0) {
    return {
      claimed: false,
      alreadyClaimed: true,
      amountPaise: Math.max(0, Number(profile.joiningBonusPaise) || JOINING_BONUS_PAISE),
      claimedAt: Number(profile.joiningClaimedAt) || 0
    };
  }

  const rewardPaise = Math.max(0, Number(profile.joiningBonusPaise) || JOINING_BONUS_PAISE);
  const credit = await creditWallet({
    userId: safeEmail,
    amountInr: rewardPaise / 100,
    paymentId: `joining_bonus:${safeEmail}`,
    source: "joining_bonus"
  });

  if (!credit?.applied && String(credit?.reason || "") !== "duplicate_payment") {
    throw new Error("Unable to apply joining bonus.");
  }

  const claimedAt = Date.now();
  store.bonusProfiles[safeEmail] = normalizeBonusProfile({
    ...profile,
    joiningClaimedAt: claimedAt,
    joiningBonusPaise: rewardPaise,
    updatedAt: claimedAt
  });
  await persistStore();

  await appendRewardEvent({
    kind: "joining_bonus",
    email: safeEmail,
    creditedEmail: safeEmail,
    promoType: "joining_bonus",
    amountPaise: rewardPaise,
    note: "Joining bonus claimed",
    actorEmail: safeEmail
  });

  await appendNotification({
    email: safeEmail,
    kind: "joining_bonus_claimed",
    title: "Joining bonus credited",
    message: "Your welcome reward has been added to the wallet.",
    actionTarget: "bonus"
  });

  return {
    claimed: true,
    alreadyClaimed: false,
    amountPaise: rewardPaise,
    claimedAt
  };
}

/**
 * Creates or updates one promo code.
 * @param {object} input
 * @param {string=} actorEmail
 * @returns {Promise<object>}
 */
async function upsertPromoCode(input, actorEmail = "") {
  ensureLoaded();

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
      : Math.max(1, Math.min(5000, Math.round(Number(input?.usageLimit) || 1))),
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
      dedupeKey: `promo_assigned:${assignedToEmail}:${promo.code}`
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
        dedupeKey: `promo_assigned:${recipient}:${promo.code}`
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
  ensureLoaded();
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
  ensureLoaded();

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

/**
 * Returns admin-friendly promo list.
 * @returns {Promise<Array<object>>}
 */
async function listPromosForAdmin() {
  ensureLoaded();
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
  ensureLoaded();

  const safeEmail = normalizeEmail(email);
  if (!safeEmail) {
    throw new Error("Valid email is required.");
  }

  const code = sanitizePromoCode(rawCode);
  if (!code || code.length < 4) {
    throw new Error("Enter a valid promo code.");
  }

  const now = Date.now();
  const promo = normalizePromoRecord(store.promos[code], code);
  if (!promo) {
    throw new Error("Promo code not found.");
  }
  if (!promo.active) {
    throw new Error("This promo code is inactive.");
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
  let creditedEmail = safeEmail;
  let paymentId = `promo_reward:${code}:${safeEmail}`;
  let walletSource = `promo_reward:${code}`;
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
    paymentId = `invite_reward:${code}:${safeEmail}`;
    walletSource = `invite_reward:${code}`;
    note = `${safeEmail} used invite code ${code}`;
    notificationTitle = "Invite reward earned";
    notificationMessage = `${safeEmail} used your invite code ${code}. Reward credited to wallet.`;
    resultMode = "invite_owner";
  } else if (promo.assignedToEmail && promo.assignedToEmail !== safeEmail) {
    throw new Error("This promo code is assigned to a different user.");
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
      code
    });
  }

  if (promo.type === "invite_bonus" && !(await isAdminEmail(safeEmail))) {
    await appendNotification({
      email: safeEmail,
      kind: "invite_code_applied",
      title: "Invite code accepted",
      message: `Invite code ${code} was accepted successfully.`,
      actionTarget: "bonus",
      code
    });
  }

  return {
    code,
    amountPaise: rewardPaise,
    creditedEmail,
    rewardMode: resultMode,
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
  ensureLoaded();

  const email = normalizeEmail(payload?.email);
  const amountInr = normalizeInr(payload?.amountInr);
  const amountPaise = Math.round(amountInr * 100);
  if (!email || amountPaise <= 0) {
    return;
  }

  const note = toSafeString(payload?.note, 120) || "Wallet bonus added";
  const actorEmail = normalizeEmail(payload?.actorEmail);

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
      actionTarget: "billing"
    });
  }
}

module.exports = {
  JOINING_BONUS_PAISE,
  getRewardDashboard,
  claimJoiningBonus,
  upsertPromoCode,
  setPromoCodeStatus,
  clearAllPromoCodes,
  listPromosForAdmin,
  redeemPromoCode,
  listNotifications,
  markNotificationRead,
  recordAdminWalletCredit
};
