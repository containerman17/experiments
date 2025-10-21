#!/bin/bash

set -euxo pipefail

sudo docker compose down;
sudo rm -rf /data/clickhouse/*;
sudo docker compose up -d;