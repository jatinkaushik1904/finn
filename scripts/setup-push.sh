#!/usr/bin/env bash
# One-time setup for closed-app alerts on a Vercel deployment:
#   1. copies the Web Push (VAPID) keys from .env.local into the project's production env;
#   2. creates a PRIVATE Vercel Blob store for push subscriptions and connects it to the project
#      (this adds BLOB_READ_WRITE_TOKEN to production);
#   3. you then redeploy:  npx vercel deploy --prod
# Run from the repo root, logged in to Vercel (npx vercel login) with the project linked.
set -euo pipefail
cd "$(dirname "$0")/.."
test -f .env.local || { echo "No .env.local here. Generate keys first: npx web-push generate-vapid-keys"; exit 1; }
for name in VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY VAPID_SUBJECT; do
  value="$(grep -E "^${name}=" .env.local | head -1 | cut -d= -f2-)"
  test -n "$value" || { echo "$name is missing from .env.local"; exit 1; }
  if npx vercel env ls production 2>/dev/null | grep -q "^ *${name} "; then
    echo "$name already set on Vercel (production): left as is"
  else
    printf '%s' "$value" | npx vercel env add "$name" production >/dev/null && echo "$name added to Vercel (production)"
  fi
done
if npx vercel env ls production 2>/dev/null | grep -q "BLOB_READ_WRITE_TOKEN"; then
  echo "A Blob store is already connected: left as is"
else
  npx vercel blob create-store finn-push --access private --region bom1 --yes --environment production && echo "Private Blob store created and connected"
fi
echo "Done. Now redeploy: npx vercel deploy --prod"
