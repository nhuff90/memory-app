#!/usr/bin/env bash
# One-time Fly.io setup and first deploy. From the repo root, after `fly auth login`:
#   bash scripts/fly-setup.sh <unique-app-name>
# Safe to re-run: existing app, volume, and secrets are kept unless you choose new ones.
set -euo pipefail

APP="${1:?Usage: bash scripts/fly-setup.sh <unique-app-name>}"
REGION="${REGION:-iad}"

command -v fly >/dev/null 2>&1 || { echo "Install flyctl first: https://fly.io/docs/flyctl/install/" >&2; exit 1; }

if fly status --app "$APP" >/dev/null 2>&1; then
  echo "Using existing app $APP."
else
  fly apps create "$APP"
fi
sed -i.bak "s/^app = .*/app = \"$APP\"/" fly.toml && rm fly.toml.bak

if fly volumes list --app "$APP" 2>/dev/null | grep -q recall_data; then
  echo "Volume recall_data already exists."
else
  # Fly snapshots the volume daily; keep 30 days of them.
  fly volumes create recall_data --app "$APP" --region "$REGION" --size 1 --snapshot-retention 30 --yes
fi

if fly secrets list --app "$APP" 2>/dev/null | grep -q RECALL_PASSWORD_HASH; then
  read -r -p "A password is already set. Choose a new one? [y/N] " answer
else
  answer=y
fi
if [[ "$answer" =~ ^[Yy] ]]; then
  echo "Choose the password you'll type to unlock Recall on your phone."
  npm run --silent hash-password | grep '^RECALL_' | fly secrets import --app "$APP" --stage
fi

read -r -s -p "Anthropic API key for Ask and auto-tagging (Enter to skip): " key
echo
if [[ -n "$key" ]]; then
  printf 'ANTHROPIC_API_KEY=%s\n' "$key" | fly secrets import --app "$APP" --stage
fi

if fly secrets list --app "$APP" 2>/dev/null | grep -q BUCKET_NAME; then
  echo "Off-site database backup is already set up."
else
  read -r -p "Also back up the database off-site, continuously, to Fly's Tigris storage (pennies a month)? [y/N] " backup
  # Creates a private bucket and sets its keys as secrets; Litestream starts using it on the next deploy.
  if [[ "$backup" =~ ^[Yy] ]]; then fly storage create --app "$APP"; fi
fi

# One machine only: the database lives on its volume.
fly deploy --app "$APP" --ha=false

echo
echo "Recall is live at https://$APP.fly.dev"
echo "On your iPhone: open it in Safari, log in, then Share > Add to Home Screen."
