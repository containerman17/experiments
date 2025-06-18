import fs from 'fs'
import chains from "../01_rpc_list/data/chains.json"
import YAML from 'yaml'

// Build services object
const services: Record<string, any> = {}

for (const chain of chains) {
    // Only add service if rpcUrl is present and not empty/null
    if (chain.rpcUrl) {
        services[`indexer_${chain.blockchainId}`] = {
            image: "containerman17/lean-explorer-core:latest",
            container_name: `indexer_${chain.blockchainId}`,
            environment: [
                `RPC_URL=${chain.rpcUrl}`,
                `CHAIN_ID=${chain.blockchainId}`,
                "DATA_DIR=/data/",
                "RPS=2",
                "REQUEST_BATCH_SIZE=300",
                "MAX_CONCURRENT=5",
                "BLOCKS_PER_BATCH=100"
            ],
            volumes: [
                "/home/ilia/indexer_data:/data"
            ],
            ports: [
                "3000" // random port
            ]
        }
    }
}

const composeObject = { services }
const yamlStr = YAML.stringify(composeObject)
fs.writeFileSync('compose.yml', yamlStr)
