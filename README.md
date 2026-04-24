# ThinkPulse Backend

Express backend for extension bootstrap config, legal pages, Stripe compatibility routes, and Razorpay payment APIs with Supabase persistence.

## Folder Structure

```
backend/
  server.js
  package.json
  .env.example
  src/
    payments/
      amounts.js
      razorpay_client.js
      supabase_store.js
      transaction_store.js
    routes/
      razorpay.js
  sql/
    payments.sql
  public/
    terms.html
    privacy.html
    refund-policy.html
    billing-success.html
    billing-cancel.html
```

## Environment Variables

Required for Razorpay payment flow:

- `RAZORPAY_KEY_ID`
- `RAZORPAY_KEY_SECRET`
- `RAZORPAY_WEBHOOK_SECRET`
- `RAZORPAY_WEBHOOK_URL` (optional override, defaults to `/webhooks` under `PUBLIC_BASE_URL`)
- `WALLET_STORE_PATH` (optional absolute/relative path for JSON wallet persistence)
- `REWARDS_STORE_PATH` (optional absolute/relative path for promo/reward JSON persistence)
- `THINKPULSE_DATA_DIR` (optional writable root used by default JSON stores on hosted deployments)
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` (preferred) or `SUPABASE_SECRET_KEY` fallback

Also keep existing keys already used by your backend:

- `PORT`
- `CORS_ORIGINS`
- Stripe variables (`STRIPE_*`) if Stripe endpoints are still used

## Payment APIs (Razorpay)

### 1) Create Order

- Endpoint: `POST /create-order`
- Body:

```json
{
  "amount": 10,
  "userId": "user_123",
  "notes": {
    "source": "extension"
  }
}
```

- Success response:

```json
{
  "ok": true,
  "keyId": "rzp_live_xxx",
  "order": {
    "id": "order_...",
    "amount": 1000,
    "currency": "INR"
  }
}
```

### 2) Create Dynamic QR

- Endpoint: `POST /create-qr`
- Body:

```json
{
  "amount": 20,
  "userId": "user_123",
  "description": "ThinkPulse premium payment"
}
```

- Success response:

```json
{
  "ok": true,
  "qr": {
    "id": "qr_...",
    "imageUrl": "https://...",
    "status": "active",
    "amountPaise": 2000,
    "amountInr": 20,
    "currency": "INR"
  },
  "transaction": {
    "qrId": "qr_...",
    "status": "pending"
  },
  "persistence": {
    "stored": true
  }
}
```

### 3) Check QR Status (Provider + Persistence)

- Endpoint: `GET /qr-status/:qrId?userId=user_123`
- Supports both:
  - QR ids (`qr_...`)
  - Order ids (`order_...`) when frontend falls back to order-based polling
- Behavior:
  - fetches latest provider status
  - updates tracked in-memory transaction state
  - when paid, persists captured payment and updates user plan/wallet state

- Success response (shape):

```json
{
  "ok": true,
  "paid": false,
  "qr": {
    "id": "qr_...",
    "status": "active"
  },
  "payment": null,
  "persistence": null,
  "transaction": {
    "qrId": "qr_...",
    "status": "pending"
  }
}
```

### 4) Check Tracked Transaction State

- Endpoint: `GET /transaction-status/:qrId`
- Behavior:
  - returns server-side tracked transaction snapshot (pending/paid/closed/expired/failed/cancelled)
  - useful for frontend fallback polling and debugging webhook matching

- Success response:

```json
{
  "ok": true,
  "found": true,
  "transaction": {
    "qrId": "qr_...",
    "status": "paid",
    "orderId": "order_...",
    "paymentId": "pay_..."
  }
}
```

### 5) Verify Payment Signature

- Endpoint: `POST /verify-payment`
- Body:

```json
{
  "razorpay_order_id": "order_xxx",
  "razorpay_payment_id": "pay_xxx",
  "razorpay_signature": "generated_signature",
  "amount": 10,
  "userId": "user_123"
}
```

- Success response:

```json
{
  "ok": true,
  "verified": true,
  "payment": {
    "orderId": "order_xxx",
    "paymentId": "pay_xxx",
    "status": "captured",
    "amountInr": 10,
    "currency": "INR"
  },
  "persistence": {
    "stored": true,
    "userUpdated": true
  },
  "transaction": {
    "qrId": "qr_...",
    "status": "paid"
  },
  "transactionMatchedBy": "orderId"
}
```

### 6) Wallet Balance

- Endpoint: `GET /wallet/:userId`
- Behavior:
  - returns user wallet snapshot maintained by webhook credits
  - supports email/userId style identifiers (URL-encoded)

- Success response:

```json
{
  "ok": true,
  "userId": "user_123",
  "balance": 20
}
```

### 7) Webhook

- Primary endpoint: `POST /webhooks`
- Compatibility alias: `POST /webhook`
- Header: `x-razorpay-signature`
- Supported events:
  - `payment.captured`
  - `payment.failed`
  - `order.paid`
- Behavior:
  - verifies webhook signature
  - logs signature verification and event details
  - for `payment.captured`/`order.paid`: credits wallet by payment amount when `payment.notes.userId` exists
  - for `payment.failed`: logs failure, does not credit wallet
  - stores payment in `payments` table
  - matches webhook to pending QR transaction (by qrId/orderId/paymentId/user+amount fallback)
  - transitions tracked transaction from `pending` to `paid`
  - best-effort updates user plan in `users`/`profiles` table

- Browser diagnostics endpoint:
  - `GET /webhooks` (or `GET /webhook`) returns webhook status page/JSON instead of "Cannot GET"

## Supabase Setup

Run SQL migration in Supabase SQL editor:

- `sql/payments.sql`

This creates the `payments` table with columns:

- `id`
- `user_id`
- `amount`
- `status`
- `payment_id`
- `created_at`

## Local Testing

1. Install and start backend

```bash
npm install
npm start
```

2. Check health

```bash
curl http://localhost:8080/health
```

3. Create order

```bash
curl -X POST http://localhost:8080/create-order \
  -H "Content-Type: application/json" \
  -d '{"amount":10,"userId":"user_123"}'
```

4. Create QR

```bash
curl -X POST http://localhost:8080/create-qr \
  -H "Content-Type: application/json" \
  -d '{"amount":20,"userId":"user_123"}'
```

5. Check QR status while payment is pending

```bash
curl "http://localhost:8080/qr-status/qr_x?userId=user_123"
```

6. Check tracked transaction state

```bash
curl "http://localhost:8080/transaction-status/qr_x"
```

7. Verify payment (after frontend checkout completes)

```bash
curl -X POST http://localhost:8080/verify-payment \
  -H "Content-Type: application/json" \
  -d '{"razorpay_order_id":"order_x","razorpay_payment_id":"pay_x","razorpay_signature":"sig_x","amount":10,"userId":"user_123"}'
```

## End-to-End Razorpay Checklist (Steps 5-13)

5. Backend creates dynamic QR via `POST /create-qr` and stores a `pending` transaction snapshot.
6. Frontend shows returned QR image/UPI intent and starts polling.
7. Frontend polls `GET /qr-status/:qrId` (and optionally `GET /transaction-status/:qrId`) until terminal state.
8. Razorpay sends webhook event (`payment.captured` / `payment.failed` / `order.paid`) to `POST /webhooks`.
9. Backend verifies `x-razorpay-signature` using raw request body and `RAZORPAY_WEBHOOK_SECRET`.
10. Backend matches webhook payment to pending transaction using qr/order/payment references with user+amount fallback.
11. Backend marks transaction `pending -> paid`, persists captured payment row, and updates user paid state.
12. Frontend sees `paid: true` / `transaction.status: paid`, then updates wallet/history/premium state once.
13. Validate full flow on a public URL (ngrok or deployed app), including webhook delivery + signature verification.

## Automated Integration Verification

Run smoke checks against a running backend:

```bash
npm run check:razorpay
```

Run full checks (creates QR, validates webhook signature, duplicate webhook idempotency, and pending transaction transition):

```bash
npm run check:razorpay:full
```

Optional arguments:

```bash
node scripts/razorpay_integration_check.js --baseUrl=http://127.0.0.1:8080 --userId=test@example.com --amount=10 --create-qr=true --idempotency-test=true
```

What this verifies:

- backend health and webhook status endpoints
- no-store cache headers on transaction/status polling endpoints
- invalid and valid Razorpay webhook signature handling
- duplicate `payment.captured` webhook idempotency
- pending transaction transition to `paid` (when QR reference is available)
- verify-payment signature rejection path

## Chrome Extension Fetch Snippets

Use these in popup/background scripts (replace `BACKEND_BASE_URL` with your deployed URL).

```js
const backendBase = "https://<your-app>.azurewebsites.net";
const userId = "user@example.com";

// 1) Create QR
const qrRes = await fetch(`${backendBase}/create-qr`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    amount: 20,
    userId,
    kind: "wallet_topup",
    description: "ThinkPulse wallet top-up"
  })
});
const qrPayload = await qrRes.json();

// 2) Poll QR status
const statusRes = await fetch(
  `${backendBase}/qr-status/${encodeURIComponent(qrPayload?.qr?.id || "")}?userId=${encodeURIComponent(userId)}`,
  { method: "GET" }
);
const statusPayload = await statusRes.json();

// 3) Read backend wallet balance
const walletRes = await fetch(`${backendBase}/wallet/${encodeURIComponent(userId)}`);
const walletPayload = await walletRes.json();
```

## Public Webhook Testing with ngrok

1. Start backend locally on port `8080`.
2. Expose backend publicly:

```bash
ngrok http 8080
```

3. Copy generated HTTPS URL and configure Razorpay webhook URL as:
  - `https://<ngrok-id>.ngrok-free.app/webhooks`
4. In Razorpay dashboard (Test Mode), enable events:
  - `payment.captured`
  - `payment.failed`
  - `order.paid`
5. Complete one QR test payment and verify:
  - webhook delivery status is `200`
  - `GET /qr-status/:qrId` returns `paid: true`
  - `GET /transaction-status/:qrId` returns `status: paid`

## Azure App Service Deployment (Node 20)

1. Configure app settings in Azure portal/App Service:

- `NODE_ENV=production`
- `PORT=8080`
- `PUBLIC_BASE_URL=https://<your-app>.azurewebsites.net`
- `RAZORPAY_KEY_ID=...`
- `RAZORPAY_KEY_SECRET=...`
- `RAZORPAY_WEBHOOK_SECRET=...`
- `RAZORPAY_WEBHOOK_URL=https://<your-app>.azurewebsites.net/webhooks`
- `SUPABASE_URL=...`
- `SUPABASE_SERVICE_ROLE_KEY=...`
- `CORS_ORIGINS=chrome-extension://<extension-id>,https://<your-app>.azurewebsites.net`

2. Deploy from backend folder:

```bash
zip -r deploy.zip . -x ".git/*" "node_modules/*" ".env"
az webapp deploy --resource-group <rg> --name <app-name> --src-path deploy.zip --type zip
```

3. Configure Razorpay webhook URL:

- `https://<your-app>.azurewebsites.net/webhooks`

Select events:

- `payment.captured`
- `payment.failed`
- `order.paid`

## Notes

- Razorpay secret and Supabase service-role key must never be exposed to frontend.
- Existing Stripe endpoints remain active and untouched for backward compatibility.
