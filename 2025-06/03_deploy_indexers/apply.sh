#!/bin/bash

set -uxe

# Load environment variables from .env file
if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
fi

npx tsx index.ts
scp compose.yml $REMOTE_SERVER_USER@$REMOTE_SERVER_IP:/tmp/idx/ || ssh $REMOTE_SERVER_USER@$REMOTE_SERVER_IP "mkdir -p /tmp/idx"
ssh $REMOTE_SERVER_USER@$REMOTE_SERVER_IP "cd /tmp/idx && docker compose pull && docker compose up -d --remove-orphans"
