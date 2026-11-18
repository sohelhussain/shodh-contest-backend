#!/usr/bin/env bash
set -e

if [ -z "$1" ]; then
  echo "Usage: $0 <user-id>" >&2
  exit 1
fi

USER_ID="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Read DEV_AUTH_SECRET from .env if present, otherwise fallback to .env.example or change_me_dev_only
SECRET=""
if [ -f "$PROJECT_ROOT/.env" ]; then
  SECRET=$(grep -E '^DEV_AUTH_SECRET=' "$PROJECT_ROOT/.env" | cut -d '=' -f2- | tr -d '\r"' || true)
fi

if [ -z "$SECRET" ] && [ -f "$PROJECT_ROOT/.env.example" ]; then
  SECRET=$(grep -E '^DEV_AUTH_SECRET=' "$PROJECT_ROOT/.env.example" | cut -d '=' -f2- | tr -d '\r"' || true)
fi

if [ -z "$SECRET" ]; then
  SECRET="change_me_dev_only"
fi

if command -v openssl >/dev/null 2>&1; then
  printf "%s" "$USER_ID" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $NF}'
elif command -v node >/dev/null 2>&1; then
  node -e "const crypto=require('crypto'); console.log(crypto.createHmac('sha256', process.argv[1]).update(process.argv[2]).digest('hex'))" "$SECRET" "$USER_ID"
elif command -v python3 >/dev/null 2>&1; then
  python3 -c "import hmac, hashlib, sys; print(hmac.new(sys.argv[1].encode(), sys.argv[2].encode(), hashlib.sha256).hexdigest())" "$SECRET" "$USER_ID"
else
  echo "Error: openssl, node, or python3 required to generate signature" >&2
  exit 1
fi
