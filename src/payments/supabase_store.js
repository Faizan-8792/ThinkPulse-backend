"use strict";

const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = String(process.env.SUPABASE_URL || "").trim();
const supabaseServiceKey = String(
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || ""
).trim();

const supabaseClient = supabaseUrl && supabaseServiceKey
  ? createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false
      }
    })
  : null;

if (!supabaseClient) {
  console.warn("[supabase] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Payment persistence is disabled.");
}

/**
 * Returns true when Supabase persistence is configured.
 * @returns {boolean}
 */
function isConfigured() {
  return Boolean(supabaseClient);
}

/**
 * Returns true when error indicates schema/table mismatch.
 * @param {any} error
 * @returns {boolean}
 */
function isSchemaError(error) {
  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("relation") ||
    message.includes("does not exist") ||
    message.includes("column") ||
    message.includes("schema")
  );
}

/**
 * Normalizes status values.
 * @param {unknown} value
 * @returns {string}
 */
function normalizeStatus(value) {
  const safe = String(value || "created").trim().toLowerCase();
  if (!safe) {
    return "created";
  }
  return safe.slice(0, 40);
}

/**
 * Converts value to safe user id string.
 * @param {unknown} value
 * @returns {string}
 */
function normalizeUserId(value) {
  return String(value || "").trim().slice(0, 180);
}

/**
 * Converts value to normalized email-like identifier.
 * @param {unknown} value
 * @returns {string}
 */
function normalizeEmailIdentifier(value) {
  const safe = String(value || "").trim().toLowerCase().slice(0, 180);
  if (!safe.includes("@")) {
    return "";
  }
  return safe;
}

/**
 * Converts date-like value to ISO timestamp.
 * @param {number|string|Date|null|undefined} value
 * @returns {string}
 */
function toIsoTimestamp(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }

  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    const millis = numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
    return new Date(millis).toISOString();
  }

  const parsed = new Date(String(value || ""));
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString();
  }

  return new Date().toISOString();
}

const GLOBAL_JSON_CONFIG_ATTEMPTS = [
  {
    table: "app_settings",
    keyColumn: "setting_key",
    valueColumn: "setting_value",
    updatedAtColumn: "updated_at"
  },
  {
    table: "app_settings",
    keyColumn: "key",
    valueColumn: "value",
    updatedAtColumn: "updated_at"
  },
  {
    table: "settings",
    keyColumn: "setting_key",
    valueColumn: "setting_value",
    updatedAtColumn: "updated_at"
  },
  {
    table: "settings",
    keyColumn: "key",
    valueColumn: "value",
    updatedAtColumn: "updated_at"
  }
];

const GLOBAL_JSON_CONFIG_KEY_MAX_LENGTH = 240;
const PAYMENT_CONFIG_ROW_PREFIX = "global_config:";
const PAYMENT_CONFIG_USER_ID = "__global_config__";

const USER_STATE_NAMESPACE_ALLOWLIST = new Set([
  "billing",
  "account"
]);

function parseJsonLikeValue(value) {
  if (value && typeof value === "object") {
    return value;
  }

  const raw = String(value || "").trim();
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch (_error) {
    return null;
  }
}

function normalizeGlobalJsonConfigKey(value) {
  return String(value || "").trim().slice(0, GLOBAL_JSON_CONFIG_KEY_MAX_LENGTH);
}

function buildPaymentConfigRowId(settingKey) {
  const safeKey = normalizeGlobalJsonConfigKey(settingKey);
  if (!safeKey) {
    return "";
  }
  return `${PAYMENT_CONFIG_ROW_PREFIX}${safeKey}`;
}

function extractPaymentConfigKey(paymentId) {
  const safePaymentId = String(paymentId || "").trim();
  if (!safePaymentId.startsWith(PAYMENT_CONFIG_ROW_PREFIX)) {
    return "";
  }
  return normalizeGlobalJsonConfigKey(safePaymentId.slice(PAYMENT_CONFIG_ROW_PREFIX.length));
}

async function getGlobalJsonConfigFromPayments(settingKey) {
  if (!supabaseClient) {
    return {
      found: false,
      reason: "Supabase is not configured."
    };
  }

  const paymentId = buildPaymentConfigRowId(settingKey);
  if (!paymentId) {
    return {
      found: false,
      reason: "Missing settingKey."
    };
  }

  const { data: rows, error } = await supabaseClient
    .from("payments")
    .select("payment_id,status,created_at")
    .eq("payment_id", paymentId)
    .limit(1);

  if (error) {
    return {
      found: false,
      reason: error.message || "Unable to read payments-backed global JSON config."
    };
  }

  const row = Array.isArray(rows) && rows.length ? rows[0] : null;
  if (!row) {
    return {
      found: false,
      reason: "No payments-backed config row found."
    };
  }

  return {
    found: true,
    table: "payments",
    keyColumn: "payment_id",
    valueColumn: "status",
    value: parseJsonLikeValue(row?.status) || {}
  };
}

async function upsertGlobalJsonConfigIntoPayments(settingKey, value) {
  if (!supabaseClient) {
    return {
      stored: false,
      reason: "Supabase is not configured."
    };
  }

  const paymentId = buildPaymentConfigRowId(settingKey);
  if (!paymentId) {
    throw new Error("settingKey is required.");
  }

  const safeValue = value && typeof value === "object" ? value : {};
  const rowPayload = {
    user_id: PAYMENT_CONFIG_USER_ID,
    amount: 0,
    status: JSON.stringify(safeValue),
    payment_id: paymentId,
    created_at: new Date().toISOString()
  };

  const { data: rows, error } = await supabaseClient
    .from("payments")
    .upsert(rowPayload, {
      onConflict: "payment_id"
    })
    .select("payment_id,status,created_at")
    .limit(1);

  if (error) {
    throw new Error(error.message || "Unable to upsert payments-backed global JSON config.");
  }

  const row = Array.isArray(rows) ? rows[0] : null;
  return {
    stored: true,
    table: "payments",
    keyColumn: "payment_id",
    valueColumn: "status",
    value: parseJsonLikeValue(row?.status) || safeValue
  };
}

async function deleteGlobalJsonConfigFromPayments(settingKey) {
  if (!supabaseClient) {
    return {
      deleted: false,
      reason: "Supabase is not configured."
    };
  }

  const paymentId = buildPaymentConfigRowId(settingKey);
  if (!paymentId) {
    return {
      deleted: false,
      reason: "Missing settingKey."
    };
  }

  const { data: rows, error } = await supabaseClient
    .from("payments")
    .delete()
    .eq("payment_id", paymentId)
    .select("id");

  if (error) {
    throw new Error(error.message || "Unable to delete payments-backed global JSON config.");
  }

  return {
    deleted: true,
    table: "payments",
    keyColumn: "payment_id",
    count: Array.isArray(rows) ? rows.length : 0
  };
}

async function listUserStateConfigsFromPayments(namespace, maxRows = 5000) {
  if (!supabaseClient) {
    return {
      ok: false,
      items: [],
      reason: "Supabase is not configured."
    };
  }

  const safeNamespace = normalizeUserStateNamespace(namespace);
  if (!safeNamespace) {
    return {
      ok: false,
      items: [],
      reason: "Unsupported namespace."
    };
  }

  const safeLimit = Number.isFinite(Number(maxRows))
    ? Math.max(1, Math.min(10000, Math.round(Number(maxRows))))
    : 5000;
  const prefix = `${PAYMENT_CONFIG_ROW_PREFIX}user_state:${safeNamespace}:`;

  const { data: rows, error } = await supabaseClient
    .from("payments")
    .select("payment_id,status,created_at")
    .like("payment_id", `${prefix}%`)
    .order("created_at", { ascending: false })
    .limit(safeLimit);

  if (error) {
    return {
      ok: false,
      items: [],
      reason: error.message || "Unable to list payments-backed user-state configs."
    };
  }

  const items = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = extractPaymentConfigKey(row?.payment_id);
    const email = extractUserStateEmail(safeNamespace, key);
    if (!email) {
      continue;
    }
    items.push({
      email,
      namespace: safeNamespace,
      value: parseJsonLikeValue(row?.status) || {},
      updatedAt: row?.created_at || ""
    });
  }

  return {
    ok: true,
    namespace: safeNamespace,
    items
  };
}

async function getGlobalJsonConfig(settingKey) {
  if (!supabaseClient) {
    return {
      found: false,
      reason: "Supabase is not configured."
    };
  }

  const safeKey = normalizeGlobalJsonConfigKey(settingKey);
  if (!safeKey) {
    return {
      found: false,
      reason: "Missing settingKey."
    };
  }

  for (const attempt of GLOBAL_JSON_CONFIG_ATTEMPTS) {
    const selectColumns = `${attempt.keyColumn},${attempt.valueColumn}`;
    const { data: rows, error } = await supabaseClient
      .from(attempt.table)
      .select(selectColumns)
      .eq(attempt.keyColumn, safeKey)
      .limit(1);

    if (error) {
      if (isSchemaError(error)) {
        continue;
      }
      return {
        found: false,
        reason: error.message || "Unable to read global JSON config."
      };
    }

    const row = Array.isArray(rows) && rows.length ? rows[0] : null;
    if (!row) {
      continue;
    }

    return {
      found: true,
      table: attempt.table,
      keyColumn: attempt.keyColumn,
      valueColumn: attempt.valueColumn,
      value: parseJsonLikeValue(row?.[attempt.valueColumn]) || {}
    };
  }

  const paymentsFallback = await getGlobalJsonConfigFromPayments(safeKey);
  if (paymentsFallback?.found) {
    return paymentsFallback;
  }

  return {
    found: false,
    reason:
      paymentsFallback?.reason ||
      "No config row found. Run backend/sql/app_settings.sql before saving premium API settings."
  };
}

async function upsertGlobalJsonConfig(settingKey, value) {
  if (!supabaseClient) {
    return {
      stored: false,
      reason: "Supabase is not configured."
    };
  }

  const safeKey = normalizeGlobalJsonConfigKey(settingKey);
  if (!safeKey) {
    throw new Error("settingKey is required.");
  }

  const safeValue = value && typeof value === "object" ? value : {};
  for (const attempt of GLOBAL_JSON_CONFIG_ATTEMPTS) {
    const rowPayload = {
      [attempt.keyColumn]: safeKey,
      [attempt.valueColumn]: safeValue
    };
    if (attempt.updatedAtColumn) {
      rowPayload[attempt.updatedAtColumn] = new Date().toISOString();
    }

    const { data: rows, error } = await supabaseClient
      .from(attempt.table)
      .upsert(rowPayload, {
        onConflict: attempt.keyColumn
      })
      .select(`${attempt.keyColumn},${attempt.valueColumn}`)
      .limit(1);

    if (error) {
      if (isSchemaError(error)) {
        continue;
      }
      throw new Error(error.message || "Unable to upsert global JSON config.");
    }

    const row = Array.isArray(rows) ? rows[0] : null;
    return {
      stored: true,
      table: attempt.table,
      keyColumn: attempt.keyColumn,
      valueColumn: attempt.valueColumn,
      value: parseJsonLikeValue(row?.[attempt.valueColumn]) || safeValue
    };
  }

  return upsertGlobalJsonConfigIntoPayments(safeKey, safeValue);
}

async function deleteGlobalJsonConfig(settingKey) {
  if (!supabaseClient) {
    return {
      deleted: false,
      reason: "Supabase is not configured."
    };
  }

  const safeKey = normalizeGlobalJsonConfigKey(settingKey);
  if (!safeKey) {
    return {
      deleted: false,
      reason: "Missing settingKey."
    };
  }

  for (const attempt of GLOBAL_JSON_CONFIG_ATTEMPTS) {
    const { data: rows, error } = await supabaseClient
      .from(attempt.table)
      .delete()
      .eq(attempt.keyColumn, safeKey)
      .select(attempt.keyColumn);

    if (error) {
      if (isSchemaError(error)) {
        continue;
      }
      throw new Error(error.message || "Unable to delete global JSON config.");
    }

    return {
      deleted: true,
      table: attempt.table,
      keyColumn: attempt.keyColumn,
      count: Array.isArray(rows) ? rows.length : 0
    };
  }

  return deleteGlobalJsonConfigFromPayments(safeKey);
}

function normalizeUserStateNamespace(value) {
  const safe = String(value || "").trim().toLowerCase().slice(0, 40);
  return USER_STATE_NAMESPACE_ALLOWLIST.has(safe) ? safe : "";
}

function buildUserStateKey(namespace, email) {
  const safeNamespace = normalizeUserStateNamespace(namespace);
  const safeEmail = normalizeEmailIdentifier(email);
  if (!safeNamespace || !safeEmail) {
    return "";
  }
  return `user_state:${safeNamespace}:${safeEmail}`;
}

function extractUserStateEmail(namespace, key) {
  const safeNamespace = normalizeUserStateNamespace(namespace);
  const safeKey = String(key || "").trim();
  const prefix = `user_state:${safeNamespace}:`;
  if (!safeNamespace || !safeKey.startsWith(prefix)) {
    return "";
  }
  return normalizeEmailIdentifier(safeKey.slice(prefix.length));
}

async function getUserStateConfig(namespace, email) {
  const key = buildUserStateKey(namespace, email);
  if (!key) {
    return {
      found: false,
      reason: "Valid namespace/email is required."
    };
  }

  const stored = await getGlobalJsonConfig(key);
  return {
    ...stored,
    namespace: normalizeUserStateNamespace(namespace),
    email: normalizeEmailIdentifier(email),
    value: stored?.found ? stored.value || {} : null
  };
}

async function upsertUserStateConfig(namespace, email, value) {
  const key = buildUserStateKey(namespace, email);
  if (!key) {
    throw new Error("Valid namespace/email is required for user-state upsert.");
  }

  const stored = await upsertGlobalJsonConfig(
    key,
    value && typeof value === "object" ? value : {}
  );

  return {
    ...stored,
    namespace: normalizeUserStateNamespace(namespace),
    email: normalizeEmailIdentifier(email)
  };
}

async function deleteUserStateConfig(namespace, email) {
  const key = buildUserStateKey(namespace, email);
  if (!key) {
    return {
      deleted: false,
      reason: "Valid namespace/email is required."
    };
  }

  const deleted = await deleteGlobalJsonConfig(key);
  return {
    ...deleted,
    namespace: normalizeUserStateNamespace(namespace),
    email: normalizeEmailIdentifier(email)
  };
}

async function listUserStateConfigs(namespace, maxRows = 5000) {
  if (!supabaseClient) {
    return {
      ok: false,
      items: [],
      reason: "Supabase is not configured."
    };
  }

  const safeNamespace = normalizeUserStateNamespace(namespace);
  if (!safeNamespace) {
    return {
      ok: false,
      items: [],
      reason: "Unsupported namespace."
    };
  }

  const safeLimit = Number.isFinite(Number(maxRows))
    ? Math.max(1, Math.min(10000, Math.round(Number(maxRows))))
    : 5000;
  const prefix = `user_state:${safeNamespace}:`;

  for (const attempt of GLOBAL_JSON_CONFIG_ATTEMPTS) {
    const selectColumns = `${attempt.keyColumn},${attempt.valueColumn}${attempt.updatedAtColumn ? `,${attempt.updatedAtColumn}` : ""}`;
    let query = supabaseClient
      .from(attempt.table)
      .select(selectColumns)
      .like(attempt.keyColumn, `${prefix}%`)
      .limit(safeLimit);

    if (attempt.updatedAtColumn) {
      query = query.order(attempt.updatedAtColumn, { ascending: false });
    }

    const { data: rows, error } = await query;
    if (error) {
      if (isSchemaError(error)) {
        continue;
      }
      throw new Error(error.message || "Unable to list user-state configs.");
    }

    const items = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      const email = extractUserStateEmail(safeNamespace, row?.[attempt.keyColumn]);
      if (!email) {
        continue;
      }
      items.push({
        email,
        namespace: safeNamespace,
        value: parseJsonLikeValue(row?.[attempt.valueColumn]) || {},
        updatedAt: row?.[attempt.updatedAtColumn] || ""
      });
    }

    return {
      ok: true,
      namespace: safeNamespace,
      items
    };
  }

  return listUserStateConfigsFromPayments(safeNamespace, safeLimit);
}

/**
 * Confirms payments table is reachable.
 * @returns {Promise<{ok:boolean,error?:string}>}
 */
async function verifyPaymentsTableAccess() {
  if (!supabaseClient) {
    return {
      ok: false,
      error: "Supabase is not configured."
    };
  }

  const { error } = await supabaseClient
    .from("payments")
    .select("id")
    .limit(1);

  if (error) {
    return {
      ok: false,
      error: error.message || "Unable to access payments table."
    };
  }

  return { ok: true };
}

/**
 * Inserts or updates payment row by payment_id.
 * @param {{userId:string,amountInr:number,status:string,paymentId:string,createdAt?:number|string|Date}} payload
 * @returns {Promise<{stored:boolean,row?:object,reason?:string}>}
 */
async function upsertPaymentRecord(payload) {
  if (!supabaseClient) {
    return {
      stored: false,
      reason: "Supabase is not configured."
    };
  }

  const paymentId = String(payload?.paymentId || "").trim();
  if (!paymentId) {
    throw new Error("paymentId is required for persistence.");
  }

  const amountInr = Number(payload?.amountInr);
  if (!Number.isFinite(amountInr) || amountInr <= 0) {
    throw new Error("amountInr must be a positive number.");
  }

  const rowPayload = {
    user_id: normalizeUserId(payload?.userId) || "unknown",
    amount: Math.round(amountInr * 100) / 100,
    status: normalizeStatus(payload?.status),
    payment_id: paymentId,
    created_at: toIsoTimestamp(payload?.createdAt)
  };

  const { data: persistedRows, error: upsertError } = await supabaseClient
    .from("payments")
    .upsert(rowPayload, {
      onConflict: "payment_id"
    })
    .select("id,user_id,amount,status,payment_id,created_at")
    .limit(1);

  if (upsertError) {
    throw new Error(upsertError.message || "Unable to upsert payment row.");
  }

  return {
    stored: true,
    row: Array.isArray(persistedRows) ? persistedRows[0] : null
  };
}

/**
 * Best-effort user-plan update for paid users.
 * Supports common users/profiles table layouts without hard failure.
 * @param {{userId:string,plan:string}} payload
 * @returns {Promise<{updated:boolean,table?:string,column?:string,reason?:string}>}
 */
async function setUserPlanState(payload) {
  if (!supabaseClient) {
    return {
      updated: false,
      reason: "Supabase is not configured."
    };
  }

  const userId = normalizeUserId(payload?.userId);
  if (!userId) {
    return {
      updated: false,
      reason: "Missing userId."
    };
  }

  const plan = String(payload?.plan || "basic").trim().toLowerCase();
  const nowIso = new Date().toISOString();
  const updateVariants = [
    {
      plan,
      updated_at: nowIso
    },
    {
      plan
    }
  ];

  const attempts = [
    { table: "users", column: "id" },
    { table: "users", column: "user_id" },
    { table: "users", column: "email" },
    { table: "profiles", column: "id" },
    { table: "profiles", column: "user_id" },
    { table: "profiles", column: "email" }
  ];

  for (const attempt of attempts) {
    for (const updates of updateVariants) {
      const { data: updatedRows, error } = await supabaseClient
        .from(attempt.table)
        .update(updates)
        .eq(attempt.column, userId)
        .select("id")
        .limit(1);

      if (!error) {
        if (Array.isArray(updatedRows) && updatedRows.length > 0) {
          return {
            updated: true,
            table: attempt.table,
            column: attempt.column
          };
        }
        break;
      }

      if (isSchemaError(error)) {
        continue;
      }

      return {
        updated: false,
        reason: error.message || "Unable to update user plan state."
      };
    }
  }

  return {
    updated: false,
    reason: "No matching users/profiles row found for this user identifier."
  };
}

/**
 * Best-effort user-plan update for paid users.
 * @param {{userId:string,plan:string}} payload
 * @returns {Promise<{updated:boolean,table?:string,column?:string,reason?:string}>}
 */
async function markUserAsPaid(payload) {
  return setUserPlanState(payload);
}

/**
 * Reads plan field from users/profiles table for one user identifier.
 * @param {{userId:string}} payload
 * @returns {Promise<{found:boolean,plan?:string,table?:string,column?:string,reason?:string}>}
 */
async function getUserPlanState(payload) {
  if (!supabaseClient) {
    return {
      found: false,
      reason: "Supabase is not configured."
    };
  }

  const userId = normalizeUserId(payload?.userId);
  if (!userId) {
    return {
      found: false,
      reason: "Missing userId."
    };
  }

  const attempts = [
    { table: "users", column: "id" },
    { table: "users", column: "user_id" },
    { table: "users", column: "email" },
    { table: "profiles", column: "id" },
    { table: "profiles", column: "user_id" },
    { table: "profiles", column: "email" }
  ];

  for (const attempt of attempts) {
    const { data: rows, error } = await supabaseClient
      .from(attempt.table)
      .select("plan")
      .eq(attempt.column, userId)
      .limit(1);

    if (error) {
      if (isSchemaError(error)) {
        continue;
      }
      return {
        found: false,
        reason: error.message || "Unable to read user plan state."
      };
    }

    const row = Array.isArray(rows) && rows.length ? rows[0] : null;
    const plan = String(row?.plan || "").trim().toLowerCase();
    if (plan) {
      return {
        found: true,
        plan,
        table: attempt.table,
        column: attempt.column
      };
    }
  }

  return {
    found: false,
    reason: "No matching users/profiles row found for this user identifier."
  };
}

/**
 * Upserts one backend user-registry marker row in payments table.
 * Uses deterministic payment_id to keep one row per user.
 * @param {{email:string,createdAt?:number|string|Date}} payload
 * @returns {Promise<{stored:boolean,row?:object,reason?:string}>}
 */
async function upsertUserRegistryRecord(payload) {
  if (!supabaseClient) {
    return {
      stored: false,
      reason: "Supabase is not configured."
    };
  }

  const email = normalizeEmailIdentifier(payload?.email);
  if (!email) {
    throw new Error("Valid email is required for user registry upsert.");
  }

  const paymentId = `user_registry:${email}`;
  const rowPayload = {
    user_id: email,
    amount: 0,
    status: "registered",
    payment_id: paymentId,
    created_at: toIsoTimestamp(payload?.createdAt)
  };

  const { data: rows, error } = await supabaseClient
    .from("payments")
    .upsert(rowPayload, {
      onConflict: "payment_id"
    })
    .select("id,user_id,amount,status,payment_id,created_at")
    .limit(1);

  if (error) {
    throw new Error(error.message || "Unable to upsert user registry row.");
  }

  return {
    stored: true,
    row: Array.isArray(rows) ? rows[0] : null
  };
}

/**
 * Lists unique known users from payments table by user_id.
 * @param {number=} maxRows
 * @returns {Promise<{ok:boolean,users:Array<object>,reason?:string}>}
 */
async function listKnownUsersFromPayments(maxRows = 5000) {
  if (!supabaseClient) {
    return {
      ok: false,
      users: [],
      reason: "Supabase is not configured."
    };
  }

  const safeLimit = Number.isFinite(Number(maxRows))
    ? Math.max(1, Math.min(10000, Math.round(Number(maxRows))))
    : 5000;

  const { data, error } = await supabaseClient
    .from("payments")
    .select("user_id,status,payment_id,created_at")
    .order("created_at", { ascending: false })
    .limit(safeLimit);

  if (error) {
    throw new Error(error.message || "Unable to list known users from payments.");
  }

  const rows = Array.isArray(data) ? data : [];
  const map = new Map();

  for (const row of rows) {
    const email = normalizeEmailIdentifier(row?.user_id);
    if (!email) {
      continue;
    }

    const createdMs = Date.parse(String(row?.created_at || "")) || Date.now();
    const status = normalizeStatus(row?.status);
    const paymentId = String(row?.payment_id || "").trim();
    const current = map.get(email);

    if (!current) {
      map.set(email, {
        email,
        firstSeenAt: createdMs,
        lastSeenAt: createdMs,
        sourceStatus: status,
        sourcePaymentId: paymentId
      });
      continue;
    }

    if (createdMs < current.firstSeenAt) {
      current.firstSeenAt = createdMs;
    }
    if (createdMs > current.lastSeenAt) {
      current.lastSeenAt = createdMs;
      current.sourceStatus = status;
      current.sourcePaymentId = paymentId;
    }
  }

  const users = [...map.values()].sort((a, b) => Number(b.lastSeenAt || 0) - Number(a.lastSeenAt || 0));

  return {
    ok: true,
    users
  };
}

/**
 * Deletes backend payment/registry rows for one email-like user id.
 * @param {{userId:string}} payload
 * @returns {Promise<{deleted:boolean,count:number,reason?:string}>}
 */
async function deleteUserPaymentRecords(payload) {
  if (!supabaseClient) {
    return {
      deleted: false,
      count: 0,
      reason: "Supabase is not configured."
    };
  }

  const userId = normalizeEmailIdentifier(payload?.userId || payload?.email);
  if (!userId) {
    return {
      deleted: false,
      count: 0,
      reason: "Missing userId."
    };
  }

  const { data, error } = await supabaseClient
    .from("payments")
    .delete()
    .eq("user_id", userId)
    .select("id");

  if (error) {
    return {
      deleted: false,
      count: 0,
      reason: error.message || "Unable to delete backend payment records."
    };
  }

  return {
    deleted: true,
    count: Array.isArray(data) ? data.length : 0
  };
}

module.exports = {
  isConfigured,
  verifyPaymentsTableAccess,
  upsertPaymentRecord,
  markUserAsPaid,
  setUserPlanState,
  getUserPlanState,
  upsertUserRegistryRecord,
  listKnownUsersFromPayments,
  deleteUserPaymentRecords,
  getGlobalJsonConfig,
  upsertGlobalJsonConfig,
  deleteGlobalJsonConfig,
  getUserStateConfig,
  upsertUserStateConfig,
  deleteUserStateConfig,
  listUserStateConfigs
};
