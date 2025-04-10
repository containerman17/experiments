# Source chain
Evm chain id 201 
Chain id PSPJDsDstwafoRHMH4ToeADFWm887WJzUe8shf3S8RLMHCMzZ 
Subnet id 2eob8mVishyekgALVg3g85NDWXHRQ1unYbBrj355MogAd9sUnb

RPC http://localhost:9650/ext/bc/PSPJDsDstwafoRHMH4ToeADFWm887WJzUe8shf3S8RLMHCMzZ/rpc

docker run -it -d \
    --name ava1 \
    -p 0.0.0.0:9650:9650 -p 9651:9651 \
    -v ~/.avalanchego_rpc:/root/.avalanchego \
    -e AVAGO_PARTIAL_SYNC_PRIMARY_NETWORK=true \
    -e AVAGO_PUBLIC_IP_RESOLUTION_SERVICE=opendns \
    -e AVAGO_HTTP_HOST=0.0.0.0 \
    -e AVAGO_TRACK_SUBNETS=2eob8mVishyekgALVg3g85NDWXHRQ1unYbBrj355MogAd9sUnb \
    -e AVAGO_HTTP_PORT=9650 \
    -e AVAGO_STAKING_PORT=9651 \
    -e AVAGO_NETWORK_ID=fuji \
    -e AVAGO_HTTP_ALLOWED_HOSTS="*" \
    -e AVAGO_THROTTLER_OUTBOUND_AT_LARGE_ALLOC_SIZE=3355443200 \
    -e AVAGO_THROTTLER_OUTBOUND_VALIDATOR_ALLOC_SIZE=3355443200 \
    -e AVAGO_THROTTLER_OUTBOUND_NODE_MAX_AT_LARGE_BYTES=209715200 \
    -e AVAGO_THROTTLER_INBOUND_BANDWIDTH_REFILL_RATE=51200 \
    -e AVAGO_THROTTLER_INBOUND_BANDWIDTH_MAX_BURST_SIZE=209715200 \
    -e AVAGO_THROTTLER_INBOUND_AT_LARGE_ALLOC_SIZE=629145600 \
    -e AVAGO_THROTTLER_INBOUND_VALIDATOR_ALLOC_SIZE=3355443200 \
    -e AVAGO_THROTTLER_INBOUND_NODE_MAX_AT_LARGE_BYTES=209715200 \
    -e AVAGO_THROTTLER_INBOUND_NODE_MAX_PROCESSING_MSGS=102400 \
    -e AVAGO_CPU_COMPACTION_SYNCER_ENABLED=false \
    -e AVAGO_ROUTER_HEALTH_MAX_OUTSTANDING_REQUESTS=20480 \
    -e AVAGO_NETWORK_HEALTH_MAX_OUTSTANDING_REQUEST_DURATION=10m \
    -e AVAGO_BENCHLIST_DURATION=5m \
    -e AVAGO_NETWORK_TIMEOUT_COEFFICIENT=3 \
    -e AVAGO_NETWORK_TIMEOUT_HALFLIFE=60m \
    avaplatform/subnet-evm:v0.7.3

{"jsonrpc":"2.0","result":{"nodeID":"NodeID-PatszT3HGk6kWYzUymMFHcoQc7eBatGc1","nodePOP":{"publicKey":"0xaa210763dd3559a0128f0b8b9aee298e640156d5fb829dc9ab94f2da9e5c65a09111846ad72f16ef657515158972b6dc","proofOfPossession":"0xb2d1555a1a6b999310f7a11da41cc6f22735302544d6494bd7a0df7628bdbca7c36325c7a324989cb2f563be30bb85c705ee5fff804460d08de167fcc26b2598ccaac55096b1ebb183fcee898597e0fa1a4e4cecefade802c948a81dcda4b99b"}},"id":1}

Sender contract 0x789a5fdac2b37fcd290fb2924382297a6ae65860

# Destination chain
Evm chain id 202 
Chain id KGAehYuq9J951RHuooVVkiJ3YEMmjpNUKx2SmW5Reb7HdBhNT 
Subnet id EhoHCadQJWLo1NV4DTWrWpdhBg1qD1oaP2fEQQGVYyao5wuDX

http://localhost:9652/ext/bc/KGAehYuq9J951RHuooVVkiJ3YEMmjpNUKx2SmW5Reb7HdBhNT/rpc

docker run -it -d \
    --name ava2 \
    -p 0.0.0.0:9652:9652 -p 9653:9653 \
    -v ~/.avalanchego:/root/.avalanchego \
    -e AVAGO_PARTIAL_SYNC_PRIMARY_NETWORK=true \
    -e AVAGO_PUBLIC_IP_RESOLUTION_SERVICE=opendns \
    -e AVAGO_HTTP_HOST=0.0.0.0 \
    -e AVAGO_TRACK_SUBNETS=EhoHCadQJWLo1NV4DTWrWpdhBg1qD1oaP2fEQQGVYyao5wuDX \
    -e AVAGO_HTTP_PORT=9652 \
    -e AVAGO_STAKING_PORT=9653 \
    -e AVAGO_NETWORK_ID=fuji \
    -e AVAGO_HTTP_ALLOWED_HOSTS="*" \
    -e AVAGO_THROTTLER_OUTBOUND_AT_LARGE_ALLOC_SIZE=3355443200 \
    -e AVAGO_THROTTLER_OUTBOUND_VALIDATOR_ALLOC_SIZE=3355443200 \
    -e AVAGO_THROTTLER_OUTBOUND_NODE_MAX_AT_LARGE_BYTES=209715200 \
    -e AVAGO_THROTTLER_INBOUND_BANDWIDTH_REFILL_RATE=51200 \
    -e AVAGO_THROTTLER_INBOUND_BANDWIDTH_MAX_BURST_SIZE=209715200 \
    -e AVAGO_THROTTLER_INBOUND_AT_LARGE_ALLOC_SIZE=629145600 \
    -e AVAGO_THROTTLER_INBOUND_VALIDATOR_ALLOC_SIZE=3355443200 \
    -e AVAGO_THROTTLER_INBOUND_NODE_MAX_AT_LARGE_BYTES=209715200 \
    -e AVAGO_THROTTLER_INBOUND_NODE_MAX_PROCESSING_MSGS=102400 \
    -e AVAGO_CPU_COMPACTION_SYNCER_ENABLED=false \
    -e AVAGO_ROUTER_HEALTH_MAX_OUTSTANDING_REQUESTS=20480 \
    -e AVAGO_NETWORK_HEALTH_MAX_OUTSTANDING_REQUEST_DURATION=10m \
    -e AVAGO_BENCHLIST_DURATION=5m \
    -e AVAGO_NETWORK_TIMEOUT_COEFFICIENT=3 \
    -e AVAGO_NETWORK_TIMEOUT_HALFLIFE=60m \
    avaplatform/subnet-evm:v0.7.3

{"jsonrpc":"2.0","result":{"nodeID":"NodeID-LhJHRARd3NAFEQwdX2ovv5wgaEwnr8JnL","nodePOP":{"publicKey":"0xa0f8020e031fcc5e34a6e8e87260b6e23999754ebf7f155016337d601b1cc0ef4eab0ad7946149a8b6c2820f26cbdb7b","proofOfPossession":"0xb15eee31771935d53fb9e95563e997cfd0740c85c198f2089d0e87aa8bd626963160ef8d6a5a0271800db3588a20bae80d1a24e3e9ec22a90b19cb443935b508f2009437a3b6b1871f9be0e0a8b1a7f1f0f9e7cfd9c9e1c313571835e066430f"}},"id":1}

receiver address 0x17ab05351fc94a1a67bf3f56ddbb941ae6c63e25

# Relayer
~/.icm-relayer/config.json

Relayer EVM Address: 0xFaEB4811A2F90E2A9cA1a1270A29B8b55d29F09a

```json
{
    "info-api": {
        "base-url": "https://api.avax-test.network"
    },
    "p-chain-api": {
        "base-url": "https://api.avax-test.network"
    },
    "source-blockchains": [
        {
            "subnet-id": "2eob8mVishyekgALVg3g85NDWXHRQ1unYbBrj355MogAd9sUnb",
            "blockchain-id": "PSPJDsDstwafoRHMH4ToeADFWm887WJzUe8shf3S8RLMHCMzZ",
            "vm": "evm",
            "rpc-endpoint": {
                "base-url": "http://localhost:9650/ext/bc/PSPJDsDstwafoRHMH4ToeADFWm887WJzUe8shf3S8RLMHCMzZ/rpc"
            },
            "ws-endpoint": {
                "base-url": "ws://localhost:9650/ext/bc/PSPJDsDstwafoRHMH4ToeADFWm887WJzUe8shf3S8RLMHCMzZ/ws"
            },
            "message-contracts": {
                "0x253b2784c75e510dD0fF1da844684a1aC0aa5fcf": {
                    "message-format": "teleporter",
                    "settings": {
                        "reward-address": "0x0000000000000000000000000000000000000000"
                    }
                }
            }
        },
        {
            "subnet-id": "EhoHCadQJWLo1NV4DTWrWpdhBg1qD1oaP2fEQQGVYyao5wuDX",
            "blockchain-id": "KGAehYuq9J951RHuooVVkiJ3YEMmjpNUKx2SmW5Reb7HdBhNT",
            "vm": "evm",
            "rpc-endpoint": {
                "base-url": "http://localhost:9652/ext/bc/KGAehYuq9J951RHuooVVkiJ3YEMmjpNUKx2SmW5Reb7HdBhNT/rpc"
            },
            "ws-endpoint": {
                "base-url": "ws://localhost:9652/ext/bc/KGAehYuq9J951RHuooVVkiJ3YEMmjpNUKx2SmW5Reb7HdBhNT/ws"
            },
            "message-contracts": {
                "0x253b2784c75e510dD0fF1da844684a1aC0aa5fcf": {
                    "message-format": "teleporter",
                    "settings": {
                        "reward-address": "0x0000000000000000000000000000000000000000"
                    }
                }
            }
        }
    ],
    "destination-blockchains": [
        {
            "subnet-id": "2eob8mVishyekgALVg3g85NDWXHRQ1unYbBrj355MogAd9sUnb",
            "blockchain-id": "PSPJDsDstwafoRHMH4ToeADFWm887WJzUe8shf3S8RLMHCMzZ",
            "vm": "evm",
            "rpc-endpoint": {
                "base-url": "http://localhost:9650/ext/bc/PSPJDsDstwafoRHMH4ToeADFWm887WJzUe8shf3S8RLMHCMzZ/rpc"
            },
            "account-private-key": "0xe0d494cc216312d0eba7b36a88ace8b8f29404d432b71e45d5a9a1a9793a6e79"
        },
        {
            "subnet-id": "EhoHCadQJWLo1NV4DTWrWpdhBg1qD1oaP2fEQQGVYyao5wuDX",
            "blockchain-id": "KGAehYuq9J951RHuooVVkiJ3YEMmjpNUKx2SmW5Reb7HdBhNT",
            "vm": "evm",
            "rpc-endpoint": {
                "base-url": "http://localhost:9652/ext/bc/KGAehYuq9J951RHuooVVkiJ3YEMmjpNUKx2SmW5Reb7HdBhNT/rpc"
            },
            "account-private-key": "0xe0d494cc216312d0eba7b36a88ace8b8f29404d432b71e45d5a9a1a9793a6e79"
        }
    ]
}
```

```bash
docker run --name relayer -d \
    --restart on-failure  \
    --user=root \
    --net=host \
    -v ~/.icm-relayer/:/icm-relayer/ \
    avaplatform/icm-relayer:v1.6.2 \
    --config-file /icm-relayer/config.json
```
