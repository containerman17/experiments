#!/bin/bash
set -euxo pipefail

cd "$(dirname "$0")"

# auto-export everything from .env
set -a
. ./.env
set +a

# sanity: must be exported
env | grep -E '^AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|REGION|EC2_METADATA_DISABLED|ENDPOINT_URL)='

~/go/bin/s5cmd \
  --endpoint-url "$AWS_ENDPOINT_URL" \
  --numworkers 128 \
  --log info \
  sync --size-only --exclude "*temp*" \
  s3://l1-archive/2q9e4r6Mu3U68nU1fYjgbR6JvwrRx36CohpAX5UQxse55x1Q5/000* /data/2q9e4r6Mu3U68nU1fYjgbR6JvwrRx36CohpAX5UQxse55x1Q5/
