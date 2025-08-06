#!/bin/bash

set -exu

updateMasterChainsJson() {
    local host=$1
    npx tsx ./scripts/updateChains.ts
    scp ./prod_chains.json $host:~/data/chains.json
}

updateReplicaChainsJson() {
    local host=$1
    ssh $host "curl -fsSL https://idx6.solokhin.com/api/replication/chains.json -o ~/data/chains.json"
}

updateAssets() {
    local host=$1
    #     npm run build
    rsync -av --delete ./dist/ $host:~/assets/
}

updatePlugins() {
    local host=$1
    # Ensure remote directories exist
    ssh $host "mkdir -p ~/data ~/plugins"
    # Sync local plugins to remote (removing any remote plugins not present locally)
    rsync -av --delete ./plugins/ $host:~/plugins/
}

updateCompose() {
    local host=$1
    scp ./compose.yml $host:~/compose.yml
}

restart() {
    local host=$1
    ssh -T $host << 'EOF'
# Run docker compose
cd ~
docker compose pull
docker compose up -d --remove-orphans
docker compose restart api fetcher indexer
EOF
}


# Single build for all hosts
npm run build

# First - update replica(s)
HOST="ubuntu@3.113.33.67"
updateReplicaChainsJson $HOST
updateAssets $HOST
updatePlugins $HOST
updateCompose $HOST
restart $HOST

# Then - update master
HOST="idx6"
updateMasterChainsJson $HOST
updateAssets $HOST
updatePlugins $HOST
updateCompose $HOST
restart $HOST
