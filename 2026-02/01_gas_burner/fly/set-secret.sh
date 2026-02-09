#!/usr/bin/env bash
set -exuo pipefail

if fly secrets list 2>/dev/null | grep -q PRIVATE_KEY; then
  echo "Secret 'PRIVATE_KEY' already exists. Aborting."
  exit 1
fi

PROJ_DIR="$(cd "$(dirname "$0")/.." && pwd)"

read -r PRIVATE_KEY ADDRESS < <(go run "${PROJ_DIR}/cmd/keygen")

fly secrets set PRIVATE_KEY="${PRIVATE_KEY}"

echo ""
echo "Secret 'PRIVATE_KEY' set on Fly.io app"
echo ""
echo "  Fund this address: ${ADDRESS}"
echo ""
