#!/bin/bash

set -exu

# Define the deployment host
HOST="idx6"
# HOST="root@168.119.154.241"

npm run build
rsync -av --delete ./dist/ $HOST:~/assets/

npx tsx ./scripts/updateChains.ts

# Ensure remote data directory exists and copy chains.json
ssh $HOST "mkdir -p ~/data ~/plugins"
scp ./prod_chains.json $HOST:~/data/chains.json

# Sync local plugins to remote (removing any remote plugins not present locally)
rsync -av --delete ./plugins/ $HOST:~/plugins/

# Copy compose.yml to remote
scp ./compose.yml $HOST:~/compose.yml

# Deploy to $HOST
ssh -T $HOST << 'EOF'
# Run docker compose
cd ~
docker compose pull
docker compose up -d --remove-orphans
docker compose restart api fetcher indexer
EOF

# TODO: This is a hack to restart the api and indexer services without starting fetcher
# ssh -T idx6 "docker compose restart api indexer"
