#!/usr/bin/env bash
# Build the ThinkPulse backend image and push it to Amazon ECR.
# Run from the backend/ directory: bash deploy/build-and-push.sh
set -euo pipefail

ACCOUNT_ID="478728045812"
REGION="us-east-1"
REPO="thinkpulse-backend"
ECR_URI="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${REPO}"

# 1. Ensure the ECR repository exists (no-op if it already does).
aws ecr describe-repositories --repository-names "${REPO}" --region "${REGION}" >/dev/null 2>&1 \
  || aws ecr create-repository --repository-name "${REPO}" --region "${REGION}"

# 2. Authenticate Docker with ECR.
aws ecr get-login-password --region "${REGION}" \
  | docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

# 3. Build (from the backend/ directory which contains the Dockerfile).
docker build -t "${REPO}" .

# 4. Tag for ECR.
docker tag "${REPO}:latest" "${ECR_URI}:latest"

# 5. Push.
docker push "${ECR_URI}:latest"

echo "Pushed ${ECR_URI}:latest"
