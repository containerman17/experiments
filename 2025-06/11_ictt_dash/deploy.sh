#!/bin/bash

set -exu

# npm run build
# rsync -av --delete ./dist/ idx5:~/assets/

# npx tsx ./scripts/updateChains.ts

# Ensure remote data directory exists and copy chains.json
ssh idx5 "mkdir -p ~/data ~/plugins"
scp ./prod_chains.json idx5:~/data/chains.json

# Sync local plugins to remote (removing any remote plugins not present locally)
rsync -av --delete ./plugins/ idx5:~/plugins/

# Copy compose.yml to remote
scp ./compose.yml idx5:~/compose.yml

# Deploy to idx5
ssh -T idx5 << 'EOF'
# Run docker compose
cd ~
docker compose pull
docker compose up -d --remove-orphans
docker compose restart api fetcher indexer
EOF
