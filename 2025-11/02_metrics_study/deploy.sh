#!/bin/bash
set -e

# Load secrets from .env to Fly.io
if [ -f .env ]; then
    echo "Setting secrets from .env..."
    fly secrets set $(grep -v '^#' .env | grep -v '^$' | xargs)
else
    echo "No .env file found, skipping secrets"
fi

# Deploy
echo "Deploying..."
fly deploy

