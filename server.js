"use strict";

const path = require("path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const dotenv = require("dotenv");

dotenv.config();

const Stripe = require("stripe");
const {
  razorpayRouter,
  razorpayWebhookHandler,
  getIntegrationState,
  verifyPaymentsTableAccess
} = require("./src/routes/razorpay");
const {
  usersRouter
} = require("./src/routes/users");
const {
  rewardsRouter
} = require("./src/routes/rewards");
const {
  authenticateRequest,
  requireRole
} = require("./src/security/auth");
const {
  attachRequestContext,
  logSecurityEvent
} = require("./src/security/logger");
const {
  createGlobalIpRateLimiter
} = require("./src/security/rate_limit");
const {
  enforceWebhookReplayProtection,
  toEpochMs
} = require("./src/security/webhook_security");

const app = express();
const port = Number(process.env.PORT || 8080);
const globalIpRateLimiter = createGlobalIpRateLimiter();

const mode = String(process.env.MODE || "test").trim().toLowerCase() === "live" ? "live" : "test";
const stripeSecretKey = mode === "live"
  ? String(process.env.STRIPE_LIVE_SECRET_KEY || "").trim()
  : String(process.env.STRIPE_TEST_SECRET_KEY || "").trim();
const webhookSecret = mode === "live"
  ? String(process.env.STRIPE_WEBHOOK_SECRET_LIVE || "").trim()
  : String(process.env.STRIPE_WEBHOOK_SECRET_TEST || "").trim();

if (!stripeSecretKey) {
  console.warn("[backend] Missing Stripe secret key for selected MODE. Checkout routes will fail until configured.");
}

const stripe = stripeSecretKey ? new Stripe(stripeSecretKey) : null;

const publicBaseUrl = String(process.env.PUBLIC_BASE_URL || "").trim();

function readEnv(name, fallback = "") {
  const value = String(process.env[name] || "").trim();
  return value || fallback;
}

function parseEnvList(name, maxItems = 50) {
  const value = readEnv(name, "");
  if (!value) {
    return [];
  }

  const seen = new Set();
  const out = [];
  for (const piece of value.split(/\r?\n|,/g)) {
    const key = String(piece || "").trim();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(key);
    if (out.length >= maxItems) {
      break;
    }
  }
  return out;
}

function resolveUrl(envName, fallbackPath) {
  const explicit = String(process.env[envName] || "").trim();
  if (explicit) {
    return explicit;
  }
  if (!publicBaseUrl) {
    return "";
  }
  try {
    const u = new URL(fallbackPath, publicBaseUrl);
    return u.toString();
  } catch (error) {
    return "";
  }
}

const urls = {
  terms: resolveUrl("TERMS_URL", "/terms"),
  privacy: resolveUrl("PRIVACY_URL", "/privacy"),
  refund: resolveUrl("REFUND_POLICY_URL", "/refund-policy"),
  stripeWebhook: resolveUrl("WEBHOOK_URL", "/stripe/webhook"),
  razorpayWebhook: resolveUrl("RAZORPAY_WEBHOOK_URL", "/webhooks"),
  success: resolveUrl("SUCCESS_URL", "/billing/success"),
  cancel: resolveUrl("CANCEL_URL", "/billing/cancel")
};

/**
 * Returns true when value is valid http/https URL.
 * @param {string} value
 * @returns {boolean}
 */
function isHttpUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return false;
  }

  try {
    const parsed = new URL(raw);
    return /^https?:$/i.test(parsed.protocol);
  } catch (_error) {
    return false;
  }
}

const envBootstrapConfig = {
  adminPool: {
    openrouter: parseEnvList("ADMIN_OPENROUTER_KEYS", 30),
    gemini: parseEnvList("ADMIN_GEMINI_KEYS", 30),
    deepseek: {
      key: readEnv("ADMIN_DEEPSEEK_KEY", ""),
      endpoint: readEnv("ADMIN_DEEPSEEK_ENDPOINT", "https://api.deepseek.com/chat/completions"),
      model: readEnv("ADMIN_DEEPSEEK_MODEL", "deepseek-chat")
    },
    qwen: {
      key: readEnv("ADMIN_QWEN_KEY", ""),
      endpoint: readEnv("ADMIN_QWEN_ENDPOINT", "https://integrate.api.nvidia.com/v1/chat/completions"),
      model: readEnv("ADMIN_QWEN_MODEL", "qwen/qwen2.5-coder-7b-instruct")
    },
    llamaPrimary: {
      key: readEnv("ADMIN_LLAMA_PRIMARY_KEY", ""),
      endpoint: readEnv("ADMIN_LLAMA_PRIMARY_ENDPOINT", "https://integrate.api.nvidia.com/v1/chat/completions"),
      model: readEnv("ADMIN_LLAMA_PRIMARY_MODEL", "meta/llama-3.1-70b-instruct")
    },
    vision: {
      key: readEnv("ADMIN_VISION_KEY", ""),
      endpoint: readEnv("ADMIN_VISION_ENDPOINT", "https://integrate.api.nvidia.com/v1/chat/completions"),
      model: readEnv("ADMIN_VISION_MODEL", "nvidia/nemotron-nano-12b-v2-vl")
    },
    imageGen: {
      key: readEnv("ADMIN_IMAGE_GEN_KEY", ""),
      endpoint: readEnv("ADMIN_IMAGE_GEN_ENDPOINT", "https://integrate.api.nvidia.com/v1/images/generations"),
      model: readEnv("ADMIN_IMAGE_GEN_MODEL", "stable-diffusion-3.5-large")
    },
    ocr: {
      ocrspace: {
        key: readEnv("ADMIN_OCRSPACE_KEY", ""),
        endpoint: readEnv("ADMIN_OCRSPACE_ENDPOINT", "https://api.ocr.space/parse/image")
      },
      nvidia: {
        key: readEnv("ADMIN_NVIDIA_OCR_KEY", ""),
        endpoint: readEnv("ADMIN_NVIDIA_OCR_ENDPOINT", "https://integrate.api.nvidia.com/v1/ocr"),
        model: readEnv("ADMIN_NVIDIA_OCR_MODEL", "nemoretriever-ocr-v1")
      }
    },
    asr: {
      key: readEnv("ADMIN_ASR_KEY", ""),
      endpoint: readEnv("ADMIN_ASR_ENDPOINT", "https://integrate.api.nvidia.com/v1/audio/transcriptions"),
      model: readEnv("ADMIN_ASR_MODEL", "ai-parakeet-ctc-1.1b-asr")
    }
  },
  webSearchDefaults: {
    tavily: parseEnvList("DEFAULT_TAVILY_SEARCH_KEYS", 30),
    serper: parseEnvList("DEFAULT_SERPER_SEARCH_KEYS", 30)
  }
};

const corsOrigins = String(process.env.CORS_ORIGINS || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

/**
 * Validates runtime environment for payment and webhook flows.
 * @returns {{errors:string[],warnings:string[]}}
 */
function validateRuntimeConfig() {
  const errors = [];
  const warnings = [];
  const nodeEnv = String(process.env.NODE_ENV || "development").trim().toLowerCase();

  const razorpayKeyId = readEnv("RAZORPAY_KEY_ID", "");
  const razorpayKeySecret = readEnv("RAZORPAY_KEY_SECRET", "");
  const razorpayWebhookSecret = readEnv("RAZORPAY_WEBHOOK_SECRET", "");
  const razorpayConfigCount = [razorpayKeyId, razorpayKeySecret, razorpayWebhookSecret]
    .filter(Boolean)
    .length;

  if (razorpayConfigCount > 0 && razorpayConfigCount < 3) {
    errors.push("Razorpay configuration is partial. Set RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, and RAZORPAY_WEBHOOK_SECRET together.");
  }

  if (publicBaseUrl && !isHttpUrl(publicBaseUrl)) {
    errors.push("PUBLIC_BASE_URL must be a valid http/https URL.");
  }

  if (urls.razorpayWebhook) {
    if (!isHttpUrl(urls.razorpayWebhook)) {
      errors.push("RAZORPAY_WEBHOOK_URL must be a valid http/https URL when set.");
    } else {
      const webhookPath = new URL(urls.razorpayWebhook).pathname;
      if (!/^\/webhooks?$/.test(webhookPath)) {
        warnings.push("RAZORPAY_WEBHOOK_URL path should be /webhooks (or /webhook alias) to match backend routes.");
      }
    }
  }

  if (nodeEnv === "production" && corsOrigins.length === 0) {
    warnings.push("CORS_ORIGINS is empty in production. This allows broad cross-origin access.");
  }

  return {
    errors,
    warnings
  };
}

const runtimeConfigValidation = validateRuntimeConfig();

for (const warning of runtimeConfigValidation.warnings) {
  console.warn("[config-warning]", warning);
}
for (const error of runtimeConfigValidation.errors) {
  console.error("[config-error]", error);
}

app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: false
}));
app.use(attachRequestContext);
app.use(globalIpRateLimiter);
app.use(cors({
  origin(origin, callback) {
    const safeOrigin = String(origin || "").trim();
    const isChromeExtension = safeOrigin.startsWith("chrome-extension://");
    if (!safeOrigin || corsOrigins.length === 0 || corsOrigins.includes(safeOrigin) || isChromeExtension) {
      callback(null, true);
      return;
    }
    callback(new Error("CORS blocked for origin: " + safeOrigin));
  }
}));

async function buildHealthPayload() {
  const integrationState = getIntegrationState();
  const paymentsTable = await verifyPaymentsTableAccess();

  return {
    ok: true,
    service: "thinkpulse-backend",
    mode,
    stripeConfigured: Boolean(stripe),
    razorpayConfigured: integrationState.razorpayConfigured,
    supabaseConfigured: integrationState.supabaseConfigured,
    configValidation: {
      errors: runtimeConfigValidation.errors,
      warnings: runtimeConfigValidation.warnings
    },
    paymentsTable,
    timestamp: Date.now()
  };
}

function shouldRenderHealthHtml(req) {
  const format = String(req.query?.format || "").trim().toLowerCase();
  if (format === "json") {
    return false;
  }
  if (format === "html") {
    return true;
  }

  const accept = String(req.headers?.accept || "").toLowerCase();
  return accept.includes("text/html");
}

function sendRazorpayWebhookStatus(req, res) {
  if (shouldRenderHealthHtml(req)) {
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(path.join(__dirname, "public", "razorpay-webhook.html"));
    return;
  }

  const integrationState = getIntegrationState();
  res.json({
    ok: true,
    service: "thinkpulse-backend",
    message: "Razorpay webhook endpoint is active. Configure Razorpay to send POST requests here.",
    endpoint: "/webhooks",
    aliases: ["/webhook"],
    method: "POST",
    signatureHeader: "x-razorpay-signature",
    razorpayConfigured: integrationState.razorpayConfigured,
    configValidation: {
      errors: runtimeConfigValidation.errors,
      warnings: runtimeConfigValidation.warnings
    },
    timestamp: Date.now()
  });
}

async function sendHealthStatus(req, res) {
  if (shouldRenderHealthHtml(req)) {
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(path.join(__dirname, "public", "health.html"));
    return;
  }

  const payload = await buildHealthPayload();
  res.json(payload);
}

app.get("/", sendHealthStatus);

app.get("/health", async (req, res) => {
  await sendHealthStatus(req, res);
});

app.get("/health.json", async (_req, res) => {
  const payload = await buildHealthPayload();

  res.json(payload);
});

app.get("/config/public", (_req, res) => {
  const integrationState = getIntegrationState();

  const publishableKey = mode === "live"
    ? String(process.env.STRIPE_LIVE_PUBLISHABLE_KEY || "").trim()
    : String(process.env.STRIPE_TEST_PUBLISHABLE_KEY || "").trim();

  res.json({
    ok: true,
    mode,
    publishableKey,
    razorpayKeyId: integrationState.razorpayKeyId,
    paymentAmountsInr: integrationState.supportedAmountsInr,
    supportEmail: String(process.env.SUPPORT_EMAIL || "").trim(),
    supportPhone: String(process.env.SUPPORT_PHONE || "").trim(),
    statementDescriptor: String(process.env.STRIPE_STATEMENT_DESCRIPTOR || "THINKPULSE").trim(),
    urls: {
      terms: urls.terms,
      privacy: urls.privacy,
      refundPolicy: urls.refund,
      success: urls.success,
      cancel: urls.cancel,
      webhook: urls.stripeWebhook,
      stripeWebhook: urls.stripeWebhook,
      razorpayWebhook: urls.razorpayWebhook
    }
  });
});

app.get("/config/default-pools", authenticateRequest(), requireRole("admin"), (_req, res) => {
  res.json({
    ok: true,
    data: envBootstrapConfig,
    fetchedAt: Date.now()
  });
});

app.get("/terms", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "terms.html"));
});

app.get("/privacy", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "privacy.html"));
});

app.get("/refund-policy", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "refund-policy.html"));
});

app.get("/site.css", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "site.css"));
});

app.get("/site.js", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "site.js"));
});

app.get("/billing/success", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "billing-success.html"));
});

app.get("/billing/cancel", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "billing-cancel.html"));
});

app.get("/stripe/webhook", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "stripe-webhook.html"));
});

app.get("/webhook", sendRazorpayWebhookStatus);
app.get("/webhooks", sendRazorpayWebhookStatus);

app.post("/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripe || !webhookSecret) {
    res.status(500).json({ ok: false, error: "Stripe webhook is not configured." });
    return;
  }

  const signature = String(req.headers["stripe-signature"] || "").trim();
  if (!signature) {
    res.status(400).json({ ok: false, error: "Missing stripe-signature header." });
    return;
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret);
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || "Webhook signature verification failed." });
    return;
  }

  const stripeReplay = await enforceWebhookReplayProtection({
    provider: "stripe",
    replayKey: String(event?.id || signature || "").trim(),
    occurredAtMs: toEpochMs(event?.created),
    maxAgeMs: 30 * 60 * 1000,
    ttlMs: 24 * 60 * 60 * 1000
  });
  if (!stripeReplay.ok) {
    logSecurityEvent("stripe_webhook_rejected", {
      reason: stripeReplay.reason,
      eventId: String(event?.id || "").trim(),
      path: "/stripe/webhook"
    }, "warn");
    res.status(stripeReplay.statusCode || 409).json({ ok: false, error: stripeReplay.error || "Webhook rejected." });
    return;
  }

  switch (event.type) {
    case "checkout.session.completed":
    case "payment_intent.succeeded":
    case "payment_intent.payment_failed":
      console.log("[stripe-webhook]", event.type, event.data?.object?.id || "");
      break;
    default:
      console.log("[stripe-webhook] ignored", event.type);
      break;
  }

  res.json({ received: true });
});

const rawJsonWebhookParser = express.raw({ type: "application/json" });
app.post("/webhook", rawJsonWebhookParser, razorpayWebhookHandler);
app.post("/webhooks", rawJsonWebhookParser, razorpayWebhookHandler);

app.use(express.json({ limit: "256kb" }));

app.use("/", usersRouter);
app.use("/", rewardsRouter);
app.use("/", razorpayRouter);

app.post("/stripe/create-checkout-session", async (req, res) => {
  if (!stripe) {
    res.status(500).json({ ok: false, error: "Stripe is not configured." });
    return;
  }

  const plan = String(req.body?.plan || "").trim().toLowerCase();
  const customerEmail = String(req.body?.email || "").trim().toLowerCase();

  const basicPrice = String(process.env.STRIPE_PRICE_BASIC_EXAM_INR_10 || "").trim();
  const premiumPrice = String(process.env.STRIPE_PRICE_PREMIUM_EXAM_INR_20 || "").trim();

  const priceId = plan === "premium" ? premiumPrice : plan === "basic" ? basicPrice : "";

  if (!priceId) {
    res.status(400).json({ ok: false, error: "Unsupported or unconfigured plan price." });
    return;
  }

  const successUrl = urls.success || resolveUrl("SUCCESS_URL", "/billing/success");
  const cancelUrl = urls.cancel || resolveUrl("CANCEL_URL", "/billing/cancel");
  if (!successUrl || !cancelUrl) {
    res.status(500).json({ ok: false, error: "SUCCESS_URL/CANCEL_URL are not configured." });
    return;
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price: priceId,
          quantity: 1
        }
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
      customer_email: customerEmail || undefined,
      metadata: {
        source: "thinkpulse-extension",
        plan
      }
    });

    res.json({
      ok: true,
      checkoutUrl: session.url,
      sessionId: session.id
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || "Checkout session failed." });
  }
});

app.listen(port, () => {
  console.log(`[backend] ThinkPulse backend listening on port ${port} in ${mode} mode`);
  if (publicBaseUrl) {
    console.log(`[backend] PUBLIC_BASE_URL = ${publicBaseUrl}`);
  }
});
