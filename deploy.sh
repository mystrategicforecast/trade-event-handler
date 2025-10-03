#!/bin/bash

# deploy.sh - Commit changes and deploy to GCP
# Usage: ./deploy.sh "your commit message"

set -e  # Exit on error

# Load environment variables from .env
if [ ! -f .env ]; then
  echo "❌ Error: .env file not found"
  exit 1
fi

# Source .env and build env-vars string for gcloud
ENV_VARS=$(grep -v '^#' .env | grep -v '^$' | paste -sd ',' -)

# Check if commit message provided
if [ -z "$1" ]; then
  echo "❌ Error: Commit message required"
  echo "Usage: ./deploy.sh \"your commit message\""
  exit 1
fi

COMMIT_MSG="$1"

echo "📦 Committing changes..."
git add .
git commit -m "$COMMIT_MSG"
git push origin main

echo ""
echo "🚀 Deploying to GCP..."
gcloud functions deploy handle-trade-event \
  --gen2 \
  --runtime nodejs20 \
  --region us-east1 \
  --trigger-topic trade-event \
  --entry-point handleTradeEvent \
  --set-env-vars "$ENV_VARS" \
  --memory 256MB \
  --timeout 60s

echo ""
echo "✅ Deploy complete!"