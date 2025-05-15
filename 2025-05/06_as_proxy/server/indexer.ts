import { RPC } from "./rpc/rpc.ts"
import dotenv from "dotenv"
import { S3BlockStore } from "./rpc/s3cache.ts";
import { CachedRPC } from "./rpc/cachedRpc.ts";
dotenv.config()

async function startLoop() {
    const uncachedRPC = new RPC(process.env.RPC_URL!);
    const chainIdbase58 = await uncachedRPC.getBlockchainIDFromPrecompile()
    const cacher = new S3BlockStore(chainIdbase58)
    const cachedRPC = new CachedRPC(cacher, uncachedRPC)

    let currentBlock = 0
    for (let i = 0; i < 20; i++) {
        console.time(`getBlock ${currentBlock}`)
        const block = await cachedRPC.getBlock(currentBlock)
        console.timeEnd(`getBlock ${currentBlock}`)
        currentBlock++
    }
}

startLoop()
