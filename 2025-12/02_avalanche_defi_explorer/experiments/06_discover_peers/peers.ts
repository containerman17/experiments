import path from 'path'
import { PoolMaster } from '../../pkg/poolsdb/PoolMaster.ts'
import { getRpcUrl } from '../../pkg/rpc.ts'
import { getCachedRpcClient } from '../../pkg/CachedRpcClient.ts'
import { fileURLToPath } from 'url'

const rpcUrl = getRpcUrl()

const cachedRpc = getCachedRpcClient(rpcUrl)

const poolsFilePath = path.resolve(path.join(fileURLToPath(import.meta.url), "../../../experiments/01_discover_pools/pools.txt"))
const poolMaster = new PoolMaster(poolsFilePath)

const inputToken = process.argv[2]
if (!inputToken) {
    console.error("Please provide an input token")
    process.exit(1)
}

console.log(`Working with token ${await cachedRpc.getSymbol(inputToken)}`)

const allNeighbors = new Set<string>()
let currentLayer = new Set<string>([inputToken])

for (let iteration = 0; iteration < 10; iteration++) {
    const nextLayer = new Set<string>()

    for (const token of currentLayer) {
        const neighbors = poolMaster.debugGetNeighbors(token)
        for (const neighbor of neighbors) {
            if (!allNeighbors.has(neighbor) && neighbor !== inputToken) {
                allNeighbors.add(neighbor)
                nextLayer.add(neighbor)
            }
        }
    }

    const layerSymbols = await Promise.all([...nextLayer].map(async (neighbor) => await cachedRpc.getSymbol(neighbor)))
    console.log(`Iteration ${iteration + 1}: Found ${nextLayer.size} new neighbors (${layerSymbols.join(", ")})`)
    console.log(`Total neighbors so far: ${allNeighbors.size}`)

    // Stop if we have 100 or more neighbors
    if (allNeighbors.size >= 100) {
        console.log(`Reached ${allNeighbors.size} neighbors, stopping early`)
        break
    }

    // Stop if no new neighbors were found
    if (nextLayer.size === 0) {
        console.log(`No new neighbors found, stopping at iteration ${iteration + 1}`)
        break
    }

    currentLayer = nextLayer
}

console.log(`\nFinal result: ${allNeighbors.size} unique neighbors`)
const allNeighborSymbols = await Promise.all([...allNeighbors].map(async (neighbor) => await cachedRpc.getSymbol(neighbor)))
console.log(`All neighbors: ${allNeighborSymbols.join(", ")}`)