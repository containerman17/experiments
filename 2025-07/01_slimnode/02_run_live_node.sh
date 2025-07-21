#!/usr/bin/env bash
set -euo pipefail

# LevelDB config for avalanchego node (only tuned fields shown):
#   compactionL0Trigger:      # L0 files threshold to trigger compaction (default 4 → tuned to 2)
#   compactionTableSize:      # target SSTable size per compaction (default 2 MiB → tuned to 1 MiB)
#   compactionTotalSize:      # max total SST size per level (default 10 MiB → tuned to 5 MiB)
#   writeBuffer:              # memtable size before flush (default 6 MiB → tuned to 8 MiB)
#   compactionExpandLimitFactor: # extra size multiplier on expand (default 25 → unchanged)
#   compactionSourceLimitFactor: # source size multiplier      (default 1  → unchanged)
#   compactionGPOverlapsFactor:   # grandparent overlap factor (default 10 → unchanged)


db_cfg_json='{
  "compactionL0Trigger": 2,
  "compactionTableSize": 1048576,
  "compactionTotalSize": 5242880,
  "writeBuffer": 8388608,
  "compactionExpandLimitFactor": 25,
  "compactionSourceLimitFactor": 1,
  "compactionGPOverlapsFactor": 10
}'
DB_CFG_B64=$(printf '%s' "${db_cfg_json}" | base64 -w0)

# -------- restart the golden node ----------
docker stop live || true
docker rm   live || true

docker pull avaplatform/subnet-evm_avalanchego:latest 

docker run -d --name live \
  -p 9650:9650 \
  -p 127.0.0.1:9651:9651 \
  -v ~/.avalanchego:/avadata/live \
  -e AVAGO_PUBLIC_IP_RESOLUTION_SERVICE=opendns \
  -e AVAGO_HTTP_HOST=0.0.0.0 \
  -e AVAGO_PARTIAL_SYNC_PRIMARY_NETWORK=true \
  -e AVAGO_TRACK_SUBNETS="" \
  -e AVAGO_NETWORK_ID=fuji \
  -e AVAGO_HTTP_ALLOWED_HOSTS="*" \
  avaplatform/subnet-evm_avalanchego:latest \
  /avalanchego/build/avalanchego \
    --db-type=leveldb \
    --db-dir=/avadata/live/db \
    --db-config-file-content "${DB_CFG_B64}"

echo "Golden node launched with aggressive LevelDB compaction."
