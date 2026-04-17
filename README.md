# ThinkPulse Backend

Express backend for Stripe checkout, webhooks, and required hosted pages.

## Files Included

- server.js
- package.json
- .env.example
- public/terms.html
- public/privacy.html
- public/refund-policy.html
- public/billing-success.html
- public/billing-cancel.html

## Local Run

1. Copy env file
- cp .env.example .env

2. Fill required env vars
- MODE=test or MODE=live
- STRIPE_TEST_SECRET_KEY / STRIPE_LIVE_SECRET_KEY
- STRIPE_WEBHOOK_SECRET_TEST / STRIPE_WEBHOOK_SECRET_LIVE
- STRIPE_PRICE_BASIC_EXAM_INR_10
- STRIPE_PRICE_PREMIUM_EXAM_INR_20
- PUBLIC_BASE_URL

3. Install and run
- npm install
- npm start

4. Verify endpoints
- GET /health
- GET /terms
- GET /privacy
- GET /refund-policy
- GET /billing/success
- GET /billing/cancel

## Azure App Service Deploy (Linux, Node 20)

1. Login and set subscription
- az login
- az account set --subscription "YOUR_SUBSCRIPTION_ID_OR_NAME"

2. Create resource group and app service plan
- az group create --name thinkpulse-rg --location centralindia
- az appservice plan create --name thinkpulse-plan --resource-group thinkpulse-rg --is-linux --sku B1

3. Create web app
- az webapp create --resource-group thinkpulse-rg --plan thinkpulse-plan --name thinkpulse-backend-UNIQUE --runtime "NODE:20-lts"

4. Set app settings
- az webapp config appsettings set --resource-group thinkpulse-rg --name thinkpulse-backend-UNIQUE --settings NODE_ENV=production PORT=8080 MODE=test PUBLIC_BASE_URL=https://thinkpulse-backend-UNIQUE.azurewebsites.net STRIPE_TEST_PUBLISHABLE_KEY=pk_test_xxx STRIPE_TEST_SECRET_KEY=sk_test_xxx STRIPE_LIVE_PUBLISHABLE_KEY=pk_live_xxx STRIPE_LIVE_SECRET_KEY=sk_live_xxx STRIPE_WEBHOOK_SECRET_TEST=whsec_test_xxx STRIPE_WEBHOOK_SECRET_LIVE=whsec_live_xxx STRIPE_PRICE_BASIC_EXAM_INR_10=price_xxx STRIPE_PRICE_PREMIUM_EXAM_INR_20=price_xxx STRIPE_STATEMENT_DESCRIPTOR=THINKPULSE SUPPORT_EMAIL=your@email.com SUPPORT_PHONE=+91XXXXXXXXXX TERMS_URL=https://thinkpulse-backend-UNIQUE.azurewebsites.net/terms PRIVACY_URL=https://thinkpulse-backend-UNIQUE.azurewebsites.net/privacy REFUND_POLICY_URL=https://thinkpulse-backend-UNIQUE.azurewebsites.net/refund-policy WEBHOOK_URL=https://thinkpulse-backend-UNIQUE.azurewebsites.net/stripe/webhook SUCCESS_URL=https://thinkpulse-backend-UNIQUE.azurewebsites.net/billing/success CANCEL_URL=https://thinkpulse-backend-UNIQUE.azurewebsites.net/billing/cancel

5. Deploy zip
- zip -r deploy.zip . -x ".git/*" "node_modules/*" ".env"
- az webapp deploy --resource-group thinkpulse-rg --name thinkpulse-backend-UNIQUE --src-path deploy.zip --type zip

6. Configure Stripe dashboard
- Add webhook endpoint: https://thinkpulse-backend-UNIQUE.azurewebsites.net/stripe/webhook
- Select events:
  - checkout.session.completed
  - payment_intent.succeeded
  - payment_intent.payment_failed
- Copy webhook signing secret to matching test/live env var.

## Extension Integration Notes

- Do not put Stripe secret keys in extension code.
- Keep all secret keys only in backend environment.
- Extension should call backend endpoint /stripe/create-checkout-session and open returned checkoutUrl.
