#!/bin/bash

node updateMeganode.ts

# Deploy to node00
scp data/meganode-compose.yml node00:/root/nodes/compose.yml
scp data/nginx.conf node00:/root/nodes/nginx.conf
ssh node00 "cd /root/nodes/ && docker compose up -d && docker restart nginx"
