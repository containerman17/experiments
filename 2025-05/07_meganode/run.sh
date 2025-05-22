#!/bin/bash

docker stop avago || true
docker rm avago || true
docker build -t myavago .

# sudo rm -rf ~/.avalanchego/staking/

docker run -it -d \
    --name avago \
    --network host \
    --log-driver json-file \
    --log-opt max-size=50m \
    --log-opt max-file=3 \
    -v ~/.avalanchego:/root/.avalanchego \
    -e AVAGO_PARTIAL_SYNC_PRIMARY_NETWORK=true \
    -e AVAGO_PUBLIC_IP_RESOLUTION_SERVICE=opendns \
    -e AVAGO_HTTP_HOST=0.0.0.0 \
    -e AVAGO_HTTP_PORT=9652 \
    -e AVAGO_STAKING_PORT=9653 \
    -e AVAGO_TRACK_SUBNETS=eYwmVU67LmSfZb1RwqCMhBYkFyG8ftxn6jAwqzFmxC9STBWLC \
    myavago

docker logs -f avago
