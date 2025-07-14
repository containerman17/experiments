#!/bin/bash

set -exu

npm run build
rsync -av --delete ./dist/ idx3:~/assets/

npx tsx ./scripts/updateChains.ts

# Ensure remote data directory exists and copy chains.json
ssh idx3 "mkdir -p ~/data ~/plugins"
scp ./prod_chains.json idx3:~/data/chains.json
rm ./prod_chains.json

# Sync local plugins to remote (removing any remote plugins not present locally)
rsync -av --delete ./plugins/ idx3:~/plugins/

# Copy compose.yml to remote
scp ./compose.yml idx3:~/compose.yml

# Deploy to idx3
ssh -T idx3 << 'EOF'
# Run docker compose
cd ~
docker compose pull
docker compose up -d --remove-orphans
docker compose restart
EOF
