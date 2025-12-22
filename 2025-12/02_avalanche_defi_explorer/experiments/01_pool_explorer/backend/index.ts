import { PoolsManager } from "../../../pkg/poolsdb/PoolsManager.ts"
import { PoolsDB } from "../../../pkg/poolsdb/PoolsDB.ts"
import * as lmdb from 'lmdb'
import { fileURLToPath } from 'url'
import path from 'path'
import { algebra } from "../../../pkg/providers/algebra.ts"
import { arenaV2 } from "../../../pkg/providers/arena_v2.ts"
import { balancerV3 } from "../../../pkg/providers/balancer_v3.ts"
import { dodo } from "../../../pkg/providers/dodo.ts"
import { lfjV1 } from "../../../pkg/providers/lfj_v1.ts"
import { lfjV2 } from "../../../pkg/providers/lfj_v2.ts"
import { pangolinV2 } from "../../../pkg/providers/pangolin_v2.ts"
import { pharaohV1 } from "../../../pkg/providers/pharaoh_v1.ts"
import { pharaohV3 } from "../../../pkg/providers/pharaoh_v3.ts"
import { uniswapV3 } from "../../../pkg/providers/uniswap_v3.ts"
import { woofiV2 } from "../../../pkg/providers/woofi_v2.ts"
import { createPublicClient, webSocket } from "viem"
import { avalanche } from 'viem/chains'

const RPC_URL = "http://167.235.8.126:9650/ext/bc/C/rpc"
const WS_RPC = "ws://167.235.8.126:9650/ext/bc/C/ws"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const poolsDataDir = path.resolve(path.join(__dirname, "../../../data/poolsdb/"))
console.log(poolsDataDir)
const poolsLmdb = lmdb.open(poolsDataDir, {
    compression: true,
})

const providers = [
    algebra,
    arenaV2,
    balancerV3,
    dodo,
    lfjV1,
    lfjV2,
    pangolinV2,
    pharaohV1,
    pharaohV3,
    uniswapV3,
    woofiV2,
]

const poolsDB = new PoolsDB(poolsLmdb.openDB({
    name: 'pools',
    compression: true
}))

const poolsManager = new PoolsManager(providers, RPC_URL, poolsLmdb, poolsDB)

const wsClient = createPublicClient({
    chain: avalanche,
    transport: webSocket(WS_RPC),
})

let lastBlockNumber = Number(await wsClient.getBlockNumber())
const catchUpTo = Math.floor(lastBlockNumber / PoolsManager.batchSize) * PoolsManager.batchSize
let lastProcessedBlockNumber = catchUpTo
await poolsManager.catchUp(catchUpTo, true)


wsClient.watchBlockNumber({
    onBlockNumber: (blockNumber: bigint) => {
        lastBlockNumber = Number(blockNumber)
    },
    onError: (error) => {
        console.error(error)
        process.exit(1)
    }
})

while (true) {
    if (lastBlockNumber <= lastProcessedBlockNumber) {
        await new Promise(resolve => setTimeout(resolve, 1))
        continue
    }
    const toBlock = Math.min(lastBlockNumber, lastProcessedBlockNumber + PoolsManager.batchSize)
    const logs = await wsClient.getLogs({
        fromBlock: BigInt(lastProcessedBlockNumber + 1),
        toBlock: BigInt(toBlock),
    })
    await poolsManager.processLiveLogs(logs)
    if ((lastProcessedBlockNumber + 1) === toBlock) {
        console.log(`Processed block ${toBlock}`)
    } else {
        console.log(`Processed ${toBlock - lastProcessedBlockNumber} blocks from ${lastProcessedBlockNumber + 1}`)
    }
    lastProcessedBlockNumber = toBlock
}