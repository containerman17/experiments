#!/usr/bin/env bash
set -euo pipefail

NAME="${1:?usage: $0 <secret-name> [namespace]}"
NAMESPACE="${2:-default}"

# Safety: refuse to touch an existing secret
if kubectl get secret "${NAME}" --namespace="${NAMESPACE}" >/dev/null 2>&1; then
  echo "ERROR: secret '${NAME}' already exists in namespace '${NAMESPACE}'. Refusing to overwrite."
  exit 1
fi

PROJ_DIR="$(cd "$(dirname "$0")/.." && pwd)"

read -r PRIVATE_KEY ADDRESS < <(go run "${PROJ_DIR}/cmd/keygen")

kubectl create secret generic "${NAME}" \
  --namespace="${NAMESPACE}" \
  --from-literal=private-key="${PRIVATE_KEY}"

echo ""
echo "Secret '${NAME}' created in namespace '${NAMESPACE}'"
echo ""
echo "  Fund this address: ${ADDRESS}"
echo ""
