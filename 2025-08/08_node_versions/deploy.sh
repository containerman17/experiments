#!/bin/bash

set -euxo pipefail

# fly app create l1-validator-discovery-mainnet
# fly app create l1-validator-discovery-fuji

go get github.com/ava-labs/avalanchego@v1.13.5
fly secrets set -a l1-validator-discovery-mainnet AVA_NETWORK=mainnet
fly deploy --app l1-validator-discovery-mainnet --primary-region iad
fly scale count 1 --app l1-validator-discovery-mainnet 


go get github.com/ava-labs/avalanchego@v1.14.0-fuji
fly secrets set -a l1-validator-discovery-fuji AVA_NETWORK=fuji
fly deploy --app l1-validator-discovery-fuji --primary-region iad
fly scale count 1 --app l1-validator-discovery-fuji 