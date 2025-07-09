#!/bin/bash

set -exu

npx tsx ./scripts/updateChains.ts

# Ensure remote data directory exists and copy chains.json
ssh idx3 "mkdir -p ~/data ~/plugins"
scp ./data/chains.json idx3:~/data/chains.json

# Sync local plugins to remote (removing any remote plugins not present locally)
rsync -av --delete ./plugins/ idx3:~/plugins/

# Deploy to idx3
ssh idx3 << 'EOF'

# Create compose.yml
cat > ~/compose.yml << 'COMPOSE'
services:
  frostbyte:
    container_name: frostbyte
    restart: on-failure:100
    image: ghcr.io/containerman17/frostbyte:latest
    volumes:
      - ~/plugins:/plugins
      - ~/data:/data
    environment:
      - PORT=80
    ports:
      - 80:80
COMPOSE

# Run docker compose
cd ~
docker compose down
docker compose pull
docker compose up -d --remove-orphans
EOF
