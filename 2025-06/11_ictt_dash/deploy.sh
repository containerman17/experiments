#!/bin/bash

set -exu

npm run build
rsync -av --delete ./dist/ idx4:~/assets/

# npx tsx ./scripts/updateChains.ts

# Ensure remote data directory exists and copy chains.json
ssh idx4 "mkdir -p ~/data ~/plugins"
# scp ./prod_chains.json idx4:~/data/chains.json
# rm ./prod_chains.json

# Sync local plugins to remote (removing any remote plugins not present locally)
rsync -av --delete ./plugins/ idx4:~/plugins/

# Copy compose.yml to remote
scp ./compose.yml idx4:~/compose.yml

# Deploy to idx4
ssh -T idx4 << 'EOF'
# Run docker compose
cd ~
docker compose pull
docker compose up -d --remove-orphans
docker compose restart api fetcher indexer
EOF
