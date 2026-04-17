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
- `RAZORPAY_WEBHOOK_URL` (optional override, defaults to `/webhook` under `PUBLIC_BASE_URL`)
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
  }
}
```

### 3) Verify Payment Signature

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
  }
}
```

### 4) Webhook

- Endpoint: `POST /webhook`
- Header: `x-razorpay-signature`
- Supported events:
  - `payment.captured`
  - `order.paid`
- Behavior:
  - verifies webhook signature
  - stores payment in `payments` table
  - best-effort updates user plan in `users`/`profiles` table

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

5. Verify payment (after frontend checkout completes)

```bash
curl -X POST http://localhost:8080/verify-payment \
  -H "Content-Type: application/json" \
  -d '{"razorpay_order_id":"order_x","razorpay_payment_id":"pay_x","razorpay_signature":"sig_x","amount":10,"userId":"user_123"}'
```

## Azure App Service Deployment (Node 20)

1. Configure app settings in Azure portal/App Service:

- `NODE_ENV=production`
- `PORT=8080`
- `PUBLIC_BASE_URL=https://<your-app>.azurewebsites.net`
- `RAZORPAY_KEY_ID=...`
- `RAZORPAY_KEY_SECRET=...`
- `RAZORPAY_WEBHOOK_SECRET=...`
- `RAZORPAY_WEBHOOK_URL=https://<your-app>.azurewebsites.net/webhook`
- `SUPABASE_URL=...`
- `SUPABASE_SERVICE_ROLE_KEY=...`
- `CORS_ORIGINS=chrome-extension://<extension-id>,https://<your-app>.azurewebsites.net`

2. Deploy from backend folder:

```bash
zip -r deploy.zip . -x ".git/*" "node_modules/*" ".env"
az webapp deploy --resource-group <rg> --name <app-name> --src-path deploy.zip --type zip
```

3. Configure Razorpay webhook URL:

- `https://<your-app>.azurewebsites.net/webhook`

Select events:

- `payment.captured`
- `order.paid`

## Notes

- Razorpay secret and Supabase service-role key must never be exposed to frontend.
- Existing Stripe endpoints remain active and untouched for backward compatibility.
