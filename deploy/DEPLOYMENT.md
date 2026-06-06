# ThinkPulse Backend — AWS ECS Deployment

## AWS targets
- Account: `478728045812`
- Region: `us-east-1`
- ECR repo: `thinkpulse-backend`
- ECR URI: `478728045812.dkr.ecr.us-east-1.amazonaws.com/thinkpulse-backend`

## App facts (verified)
- Entry: `server.js` (`npm start` -> `node server.js`)
- Node: 20
- Port: `process.env.PORT` (fallback 8080), binds `0.0.0.0`
- Health: `GET /health.json` -> 200 JSON; `GET /health` -> HTML
- Persistence: Supabase (set `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`); local `data/*.json` is dev-only fallback and is NOT durable on ECS.
- Reverse proxy: `app.set("trust proxy", 1)` is enabled.

## 1. Create the secret (once)
```bash
cd backend
bash deploy/create-secret.sh
```

## 2. Build + push image
```bash
cd backend
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 478728045812.dkr.ecr.us-east-1.amazonaws.com
docker build -t thinkpulse-backend .
docker tag thinkpulse-backend:latest 478728045812.dkr.ecr.us-east-1.amazonaws.com/thinkpulse-backend:latest
docker push 478728045812.dkr.ecr.us-east-1.amazonaws.com/thinkpulse-backend:latest
```
Or: `bash deploy/build-and-push.sh`

## 3. Register task definition
```bash
aws ecs register-task-definition --cli-input-json file://deploy/ecs-task-definition.json --region us-east-1
```

## ECS service settings
- Launch type: Fargate
- Container port: 8080
- CPU: 512 (.5 vCPU) / Memory: 1024 MB
- Desired count: 1 (raise for HA)
- Health check path (ALB target group): `/health.json`, healthy code 200
- ALB listener: HTTPS 443 -> target group HTTP 8080
- Security group: ALB allows 443 inbound; service SG allows 8080 from ALB SG only

## After first deploy
- Set `PUBLIC_BASE_URL` and `RAZORPAY_WEBHOOK_URL` to the ALB/custom domain, re-register task def, update service.
- Point extension `DEFAULT_BACKEND_BASE_URL` to the new URL.
- Update Razorpay webhook URL to `<new-url>/webhooks`.
