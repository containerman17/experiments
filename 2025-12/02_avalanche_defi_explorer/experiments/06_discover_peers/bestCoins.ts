import path from "path"
import { PoolMaster } from "../../pkg/poolsdb/PoolMaster.ts"
import { getRpcUrl } from "../../pkg/rpc.ts"
import { CachedRpcClient } from "../../pkg/CachedRpcClient.ts"

const poolsFilePath = path.join(import.meta.dirname, "../01_discover_pools/pools.txt")
const rpcUrl = getRpcUrl()
const cachedRpcClient = new CachedRpcClient(rpcUrl)
const poolmaster = new PoolMaster(poolsFilePath)

const totalCoins = poolmaster.getAllCoins(0,)
const totalPools = poolmaster.getPoolsWithLimitedCoinSet(totalCoins)
console.log(`Total 
    coins: ${totalCoins.length} 
    pools: ${totalPools.length}`)
const coins2 = poolmaster.getAllCoins(2)
const pools2 = poolmaster.getPoolsWithLimitedCoinSet(coins2)
console.log(`Coins with at least 2 pools: 
    coins: ${coins2.length} 
    pools: ${pools2.length}`)

const coins2_10 = poolmaster.getAllCoins(2, 10)
const pools2_10 = poolmaster.getPoolsWithLimitedCoinSet(coins2_10)
console.log(`Coins with at least 2 pools and 10 swaps: 
    coins: ${coins2_10.length} 
    pools: ${pools2_10.length}`)

const coins2_100 = poolmaster.getAllCoins(2, 100)
const pools2_100 = poolmaster.getPoolsWithLimitedCoinSet(coins2_100)
console.log(`Coins with at least 2 pools and 100 swaps: 
    coins: ${coins2_100.length} 
    pools: ${pools2_100.length}`)

const allCoins2 = poolmaster.getAllCoins(2, 0, "combined")
for (const limit of [2, 5, 10, 20, 50, 100, 200]) {
    const topCoins = allCoins2.slice(0, limit)
    const coinNames = await Promise.all(topCoins.map(coin => cachedRpcClient.getSymbol(coin)))
    const topPools = poolmaster.getPoolsWithLimitedCoinSet(topCoins)
    console.log(`Top ${limit} coins: 
    coins: ${topCoins.length} (${coinNames.join(", ")})
    pools: ${topPools.length}`)
}

process.exit(0)
