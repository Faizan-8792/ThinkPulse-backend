#!/usr/bin/env bash
# Creates the AWS Secrets Manager secret "thinkpulse/backend" from your local
# backend/.env file. The ECS task definition references individual keys from
# this secret. Run from the backend/ directory: bash deploy/create-secret.sh
set -euo pipefail

REGION="us-east-1"
SECRET_NAME="thinkpulse/backend"
ENV_FILE=".env"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing ${ENV_FILE}. Run from the backend/ directory." >&2
  exit 1
fi

# Convert the .env file into a single JSON object {KEY: "value", ...},
# skipping comments and blank lines.
JSON=$(node -e '
  const fs = require("fs");
  const lines = fs.readFileSync(".env", "utf8").split(/\r?\n/);
  const out = {};
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim();
    if (k) out[k] = v;
  }
  process.stdout.write(JSON.stringify(out));
')

# Create or update the secret.
if aws secretsmanager describe-secret --secret-id "${SECRET_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  aws secretsmanager put-secret-value \
    --secret-id "${SECRET_NAME}" \
    --secret-string "${JSON}" \
    --region "${REGION}"
else
  aws secretsmanager create-secret \
    --name "${SECRET_NAME}" \
    --secret-string "${JSON}" \
    --region "${REGION}"
fi

echo "Secret ${SECRET_NAME} is ready in ${REGION}."
