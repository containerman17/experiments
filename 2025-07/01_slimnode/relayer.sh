docker run --name relayer -d \
    --restart on-failure  \
    --user=root \
    --network=host \
    -v $(pwd)/dev_config.json:/icm-relayer/config.json \
    avaplatform/icm-relayer:v1.6.6 \
    --config-file /icm-relayer/config.json