import path from "path"
import { PoolMaster } from "../../pkg/poolsdb/PoolMaster.ts"
import { getRpcUrl } from "../../pkg/rpc.ts"
import { CachedRpcClient } from "../../pkg/CachedRpcClient.ts"


const poolsFilePath = path.join(import.meta.dirname, "../01_discover_pools/pools.txt")
const rpcUrl = getRpcUrl()
const cachedRpcClient = new CachedRpcClient(rpcUrl)
const poolmaster = new PoolMaster(poolsFilePath)

const LIMIT = 100

const topCoinsByPoolCount = poolmaster.getAllCoins(2, 0, "pool_count").slice(0, LIMIT)
const topCoinsByPoolCountNames = await Promise.all(topCoinsByPoolCount.map(coin => cachedRpcClient.getSymbol(coin)))
console.log(`Sorted by pool count: ${topCoinsByPoolCount.length} (${topCoinsByPoolCountNames.join(", ")})`)

const topCoinsSortedBySwaps = poolmaster.getAllCoins(2, 0, "swap_count").slice(0, LIMIT)
const topCoinsSortedBySwapsNames = await Promise.all(topCoinsSortedBySwaps.map(coin => cachedRpcClient.getSymbol(coin)))
console.log(`Sorted by swap count: ${topCoinsSortedBySwaps.length} (${topCoinsSortedBySwapsNames.join(", ")})`)

const topCoinsCombined = poolmaster.getAllCoins(2, 0, "combined").slice(0, LIMIT)
const topCoinsCombinedNames = await Promise.all(topCoinsCombined.map(coin => cachedRpcClient.getSymbol(coin)))
console.log(`Sorted by combined rank: ${topCoinsCombined.length} (${topCoinsCombinedNames.join(", ")})`)

//TODO: show message if every element of topCoinsByPoolCount equal to topCoinsSortedBySwaps
if (topCoinsByPoolCount.every((coin, index) => coin === topCoinsSortedBySwaps[index])) {
    console.log("Top coins by pool count and swap count are the same. That means that sorting by swap count is not working")
} else {
    console.log("Top coins by pool count and swap count are different")
}
