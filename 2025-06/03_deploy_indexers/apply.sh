#!/bin/bash

set -uxe

npx tsx index.ts
scp compose.yml root@65.21.140.118:/tmp/idx/ || ssh root@65.21.140.118 "mkdir -p /tmp/idx"
# ssh root@65.21.140.118 "cd /tmp/idx && docker compose down && docker compose pull &&docker compose up -d"
ssh root@65.21.140.118 "cd /tmp/idx && docker compose pull && docker compose up -d"
