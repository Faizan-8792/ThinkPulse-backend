#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const path = require("path");
const dotenv = require("dotenv");

dotenv.config({
  path: path.resolve(__dirname, "..", ".env")
});

/**
 * Parses CLI flags in --key=value or --flag style.
 * @param {string[]} argv
 * @returns {Record<string, string|boolean>}
 */
function parseArgs(argv) {
  const out = {};
  for (const piece of argv) {
    const value = String(piece || "").trim();
    if (!value.startsWith("--")) {
      continue;
    }

    const withoutPrefix = value.slice(2);
    const eqIndex = withoutPrefix.indexOf("=");
    if (eqIndex < 0) {
      out[withoutPrefix] = true;
      continue;
    }

    const key = withoutPrefix.slice(0, eqIndex).trim();
    const rawValue = withoutPrefix.slice(eqIndex + 1).trim();
    if (!key) {
      continue;
    }
    out[key] = rawValue;
  }
  return out;
}

/**
 * Returns true for common truthy flag values.
 * @param {string|boolean|undefined} value
 * @returns {boolean}
 */
function asBool(value) {
  if (value === true) {
    return true;
  }
  const safe = String(value || "").trim().toLowerCase();
  return ["1", "true", "yes", "on", "full"].includes(safe);
}

/**
 * Performs JSON HTTP request.
 * @param {string} method
 * @param {string} url
 * @param {object=} body
 * @param {Record<string,string>=} extraHeaders
 * @returns {Promise<{status:number,headers:Headers,json:any,text:string}>}
 */
async function requestJson(method, url, body, extraHeaders = {}) {
  const headers = {
    Accept: "application/json",
    ...extraHeaders
  };
  const init = {
    method,
    headers,
    cache: "no-store"
  };

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  const response = await fetch(url, init);
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_error) {
    json = null;
  }

  return {
    status: response.status,
    headers: response.headers,
    json,
    text
  };
}

/**
 * Builds absolute URL from base + path.
 * @param {string} baseUrl
 * @param {string} path
 * @returns {string}
 */
function buildUrl(baseUrl, path) {
  return new URL(path, `${baseUrl.replace(/\/+$/, "")}/`).toString();
}

/**
 * Signs webhook payload with secret.
 * @param {string} secret
 * @param {string} rawBody
 * @returns {string}
 */
function signWebhook(secret, rawBody) {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

/**
 * Returns true if response header contains substring.
 * @param {Headers} headers
 * @param {string} key
 * @param {string} needle
 * @returns {boolean}
 */
function headerHas(headers, key, needle) {
  const value = String(headers.get(key) || "").toLowerCase();
  return value.includes(String(needle || "").toLowerCase());
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = String(
    args.baseUrl || process.env.CHECK_BASE_URL || `http://127.0.0.1:${process.env.PORT || 8080}`
  )
    .trim()
    .replace(/\/+$/, "");
  const amountInr = Math.max(10, Math.round(Number(args.amount || 10) || 10));
  const userId = String(
    args.userId || `integration-check+${Date.now()}@example.com`
  )
    .trim()
    .toLowerCase();
  const webhookSecret = String(args.webhookSecret || process.env.RAZORPAY_WEBHOOK_SECRET || "").trim();

  const runFull = asBool(args.full);
  const runCreateQr = runFull || asBool(args["create-qr"]);
  const runIdempotency = runFull || asBool(args["idempotency-test"]);

  const checks = [];

  /**
   * @param {string} name
   * @param {"PASS"|"FAIL"|"SKIP"} status
   * @param {string} detail
   */
  function pushCheck(name, status, detail) {
    checks.push({ name, status, detail });
  }

  let createdQrId = "";
  let createdOrderId = "";

  try {
    const health = await requestJson("GET", buildUrl(baseUrl, "/health.json"));
    if (health.status === 200 && health.json?.ok === true) {
      pushCheck("Health endpoint", "PASS", "GET /health.json returned ok=true");
    } else {
      pushCheck("Health endpoint", "FAIL", `Unexpected status=${health.status}`);
    }
  } catch (error) {
    pushCheck("Health endpoint", "FAIL", `Request failed: ${error?.message || error}`);
  }

  try {
    const webhookInfo = await requestJson("GET", buildUrl(baseUrl, "/webhooks?format=json"));
    if (webhookInfo.status === 200 && webhookInfo.json?.ok === true) {
      pushCheck("Webhook status endpoint", "PASS", "GET /webhooks?format=json reachable");
    } else {
      pushCheck("Webhook status endpoint", "FAIL", `Unexpected status=${webhookInfo.status}`);
    }
  } catch (error) {
    pushCheck("Webhook status endpoint", "FAIL", `Request failed: ${error?.message || error}`);
  }

  try {
    const txStatus = await requestJson(
      "GET",
      buildUrl(baseUrl, "/transaction-status/order_cache_header_probe")
    );
    const hasNoStore = headerHas(txStatus.headers, "cache-control", "no-store");
    if (txStatus.status === 200 && hasNoStore) {
      pushCheck("Transaction status no-store", "PASS", "Cache-Control includes no-store");
    } else {
      pushCheck(
        "Transaction status no-store",
        "FAIL",
        `status=${txStatus.status}, cache-control=${txStatus.headers.get("cache-control") || ""}`
      );
    }
  } catch (error) {
    pushCheck("Transaction status no-store", "FAIL", `Request failed: ${error?.message || error}`);
  }

  if (runCreateQr) {
    try {
      const createQr = await requestJson("POST", buildUrl(baseUrl, "/create-qr"), {
        amount: amountInr,
        userId,
        kind: "wallet_topup",
        description: "Integration check QR"
      });

      if (createQr.status === 201 && createQr.json?.ok === true && createQr.json?.qr?.id) {
        createdQrId = String(createQr.json.qr.id || "").trim();
        createdOrderId = String(createQr.json.qr.orderId || createQr.json.qr.order_id || "").trim();
        pushCheck("Create QR flow", "PASS", `Created reference ${createdQrId}`);

        const qrStatus = await requestJson(
          "GET",
          buildUrl(
            baseUrl,
            `/qr-status/${encodeURIComponent(createdQrId)}?userId=${encodeURIComponent(userId)}`
          )
        );
        const hasNoStore = headerHas(qrStatus.headers, "cache-control", "no-store");
        if (qrStatus.status === 200 && qrStatus.json?.ok === true && hasNoStore) {
          pushCheck("QR status polling endpoint", "PASS", "qr-status reachable and non-cacheable");
        } else {
          pushCheck(
            "QR status polling endpoint",
            "FAIL",
            `status=${qrStatus.status}, cache-control=${qrStatus.headers.get("cache-control") || ""}`
          );
        }
      } else {
        pushCheck(
          "Create QR flow",
          "FAIL",
          `status=${createQr.status}, error=${String(createQr.json?.error || "unknown")}`
        );
      }
    } catch (error) {
      pushCheck("Create QR flow", "FAIL", `Request failed: ${error?.message || error}`);
    }
  } else {
    pushCheck("Create QR flow", "SKIP", "Enable with --create-qr=true or --full=true");
    pushCheck("QR status polling endpoint", "SKIP", "Requires QR creation");
  }

  try {
    const invalidVerify = await requestJson("POST", buildUrl(baseUrl, "/verify-payment"), {
      razorpay_order_id: "order_invalid_check",
      razorpay_payment_id: "pay_invalid_check",
      razorpay_signature: "invalid_signature",
      amount: 10,
      userId
    });

    if (invalidVerify.status === 400 && invalidVerify.json?.verified === false) {
      pushCheck("Verify-payment signature rejection", "PASS", "Invalid signature rejected");
    } else {
      pushCheck(
        "Verify-payment signature rejection",
        "FAIL",
        `Expected 400 invalid signature, got status=${invalidVerify.status}`
      );
    }
  } catch (error) {
    pushCheck("Verify-payment signature rejection", "FAIL", `Request failed: ${error?.message || error}`);
  }

  if (webhookSecret) {
    try {
      const eventPayload = {
        event: "integration.check.ping",
        payload: {
          payment: {
            entity: {
              id: `pay_ping_${Date.now()}`
            }
          }
        }
      };
      const rawBody = JSON.stringify(eventPayload);

      const invalidSigResponse = await fetch(buildUrl(baseUrl, "/webhooks"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-razorpay-signature": "invalid_signature"
        },
        body: rawBody
      });

      if (invalidSigResponse.status === 401) {
        pushCheck("Webhook invalid signature", "PASS", "Invalid signature rejected with 401");
      } else {
        pushCheck(
          "Webhook invalid signature",
          "FAIL",
          `Expected 401, got ${invalidSigResponse.status}`
        );
      }

      const validSignature = signWebhook(webhookSecret, rawBody);
      const validSigResponse = await requestJson(
        "POST",
        buildUrl(baseUrl, "/webhooks"),
        eventPayload,
        {
          "x-razorpay-signature": validSignature
        }
      );

      if (validSigResponse.status === 200 && validSigResponse.json?.ok === true) {
        pushCheck("Webhook valid signature", "PASS", "Valid signature accepted");
      } else {
        pushCheck(
          "Webhook valid signature",
          "FAIL",
          `Expected 200, got ${validSigResponse.status}`
        );
      }
    } catch (error) {
      pushCheck("Webhook signature checks", "FAIL", `Request failed: ${error?.message || error}`);
    }
  } else {
    pushCheck("Webhook signature checks", "SKIP", "RAZORPAY_WEBHOOK_SECRET missing");
  }

  if (runIdempotency) {
    if (!webhookSecret) {
      pushCheck("Duplicate webhook idempotency", "SKIP", "Requires RAZORPAY_WEBHOOK_SECRET");
      pushCheck("Polling success transition", "SKIP", "Requires idempotency webhook test setup");
    } else {
      try {
        const paymentId = `pay_intchk_${Date.now().toString(36)}`;
        const orderId = createdOrderId || `order_intchk_${Date.now().toString(36)}`;
        const paymentCapturedEvent = {
          event: "payment.captured",
          payload: {
            payment: {
              entity: {
                id: paymentId,
                order_id: orderId,
                status: "captured",
                amount: amountInr * 100,
                created_at: Math.floor(Date.now() / 1000),
                notes: {
                  userId,
                  kind: "wallet_topup"
                }
              }
            }
          }
        };

        const rawBody = JSON.stringify(paymentCapturedEvent);
        const signature = signWebhook(webhookSecret, rawBody);

        const first = await requestJson(
          "POST",
          buildUrl(baseUrl, "/webhooks"),
          paymentCapturedEvent,
          {
            "x-razorpay-signature": signature
          }
        );

        const second = await requestJson(
          "POST",
          buildUrl(baseUrl, "/webhooks"),
          paymentCapturedEvent,
          {
            "x-razorpay-signature": signature
          }
        );

        const firstApplied = first.status === 200 && first.json?.wallet?.applied === true;
        const secondDuplicate =
          second.status === 200 &&
          second.json?.wallet?.applied === false &&
          String(second.json?.wallet?.reason || "") === "duplicate_payment";

        if (firstApplied && secondDuplicate) {
          pushCheck("Duplicate webhook idempotency", "PASS", "Second webhook prevented duplicate credit");
        } else {
          pushCheck(
            "Duplicate webhook idempotency",
            "FAIL",
            `firstApplied=${first.json?.wallet?.applied}, secondReason=${String(second.json?.wallet?.reason || "")}`
          );
        }

        if (createdQrId) {
          const txStatus = await requestJson(
            "GET",
            buildUrl(baseUrl, `/transaction-status/${encodeURIComponent(createdQrId)}`)
          );
          const paidState = String(txStatus.json?.transaction?.status || "").toLowerCase() === "paid";

          if (txStatus.status === 200 && txStatus.json?.found === true && paidState) {
            pushCheck("Polling success transition", "PASS", "Pending transaction transitioned to paid");
          } else {
            pushCheck(
              "Polling success transition",
              "FAIL",
              `status=${txStatus.status}, found=${txStatus.json?.found}, txStatus=${txStatus.json?.transaction?.status || ""}`
            );
          }
        } else {
          pushCheck("Polling success transition", "SKIP", "No QR reference created; run with --create-qr=true");
        }
      } catch (error) {
        pushCheck("Duplicate webhook idempotency", "FAIL", `Request failed: ${error?.message || error}`);
        pushCheck("Polling success transition", "FAIL", `Request failed: ${error?.message || error}`);
      }
    }
  } else {
    pushCheck("Duplicate webhook idempotency", "SKIP", "Enable with --idempotency-test=true or --full=true");
    pushCheck("Polling success transition", "SKIP", "Enable with --idempotency-test=true or --full=true");
  }

  const passCount = checks.filter((item) => item.status === "PASS").length;
  const failCount = checks.filter((item) => item.status === "FAIL").length;
  const skipCount = checks.filter((item) => item.status === "SKIP").length;

  console.log("\nRazorpay Integration Check Report");
  console.log("================================");
  console.log(`Base URL: ${baseUrl}`);
  console.log(`User ID: ${userId}`);
  console.log(`Amount INR: ${amountInr}`);
  console.log(`Checks: PASS=${passCount} FAIL=${failCount} SKIP=${skipCount}`);
  console.log("");

  for (const check of checks) {
    console.log(`[${check.status}] ${check.name} - ${check.detail}`);
  }

  process.exitCode = failCount > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error("Integration check failed:", error?.message || error);
  process.exitCode = 1;
});
