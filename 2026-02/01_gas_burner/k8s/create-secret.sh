#!/usr/bin/env bash
set -euo pipefail

NAMESPACE="${1:-default}"

PROJ_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TMPFILE=$(mktemp "${PROJ_DIR}/keygen_XXXXXX.go")
trap "rm -f ${TMPFILE}" EXIT

cat > "${TMPFILE}" <<'GOEOF'
package main

import (
	"fmt"
	"github.com/ethereum/go-ethereum/crypto"
)

func main() {
	key, err := crypto.GenerateKey()
	if err != nil { panic(err) }
	fmt.Printf("%x %s\n", crypto.FromECDSA(key), crypto.PubkeyToAddress(key.PublicKey).Hex())
}
GOEOF

read -r PRIVATE_KEY ADDRESS < <(go run "${TMPFILE}")

kubectl create secret generic gas-burner-private-key \
  --namespace="${NAMESPACE}" \
  --from-literal=private-key="${PRIVATE_KEY}" \
  --dry-run=client -o yaml | kubectl apply -f -

echo ""
echo "Secret 'gas-burner-private-key' created in namespace '${NAMESPACE}'"
echo ""
echo "  Fund this address: ${ADDRESS}"
echo ""
