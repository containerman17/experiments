#!/bin/bash
set -e

# Load secrets from .env to Fly.io (only if changed)
if [ -f .env ]; then
    current_hash=$(md5sum .env | cut -d' ' -f1)
    stored_hash=""
    [ -f .env.deployed ] && stored_hash=$(cat .env.deployed)
    
    if [ "$current_hash" != "$stored_hash" ]; then
        echo "Setting secrets from .env..."
        fly secrets set $(grep -v '^#' .env | grep -v '^$' | xargs)
        echo "$current_hash" > .env.deployed
    else
        echo ".env unchanged, skipping secrets"
    fi
else
    echo "No .env file found, skipping secrets"
fi

# Deploy
echo "Deploying..."
fly deploy

