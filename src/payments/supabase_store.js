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
  deleteUserPaymentRecords
};
