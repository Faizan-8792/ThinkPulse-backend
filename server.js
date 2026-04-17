"use strict";

const path = require("path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const dotenv = require("dotenv");
const Stripe = require("stripe");

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 8080);

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
  webhook: resolveUrl("WEBHOOK_URL", "/stripe/webhook"),
  success: resolveUrl("SUCCESS_URL", "/billing/success"),
  cancel: resolveUrl("CANCEL_URL", "/billing/cancel")
};

const corsOrigins = String(process.env.CORS_ORIGINS || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: false
}));
app.use(cors({
  origin(origin, callback) {
    if (!origin || corsOrigins.length === 0 || corsOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error("CORS blocked for origin: " + origin));
  }
}));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "thinkpulse-backend",
    mode,
    stripeConfigured: Boolean(stripe),
    timestamp: Date.now()
  });
});

app.get("/config/public", (_req, res) => {
  const publishableKey = mode === "live"
    ? String(process.env.STRIPE_LIVE_PUBLISHABLE_KEY || "").trim()
    : String(process.env.STRIPE_TEST_PUBLISHABLE_KEY || "").trim();

  res.json({
    ok: true,
    mode,
    publishableKey,
    supportEmail: String(process.env.SUPPORT_EMAIL || "").trim(),
    supportPhone: String(process.env.SUPPORT_PHONE || "").trim(),
    statementDescriptor: String(process.env.STRIPE_STATEMENT_DESCRIPTOR || "THINKPULSE").trim(),
    urls: {
      terms: urls.terms,
      privacy: urls.privacy,
      refundPolicy: urls.refund,
      success: urls.success,
      cancel: urls.cancel,
      webhook: urls.webhook
    }
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

app.get("/billing/success", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "billing-success.html"));
});

app.get("/billing/cancel", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "billing-cancel.html"));
});

app.post("/stripe/webhook", express.raw({ type: "application/json" }), (req, res) => {
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

app.use(express.json());

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
