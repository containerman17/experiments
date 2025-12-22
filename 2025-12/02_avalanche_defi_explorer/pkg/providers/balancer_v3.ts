import { type Log, decodeAbiParameters } from 'viem'
import { type PoolProvider, type SwapEvent, type CachedRPC } from './_types.ts'

const BALANCER_V3_VAULT = '0xba1333333333a1ba1108e8412f11850a5c319ba9'


// Swap(address indexed pool, IERC20 indexed tokenIn, IERC20 indexed tokenOut, uint256 amountIn, uint256 amountOut, uint256 swapFeePercentage, uint256 swapFeeAmount)
const SWAP_TOPIC = '0x0874b2d545cb271cdbda4e093020c452328b24af12382ed62c4d00f5c26709db'

export const balancerV3: PoolProvider = {
    name: 'balancer_v3',
    poolType: 6,
    topics: [SWAP_TOPIC],

    async processLogs(logs: Log[], _cachedRPC: CachedRPC): Promise<SwapEvent[]> {
        const swaps: SwapEvent[] = []

        for (const log of logs) {
            // Only process logs from Balancer V3 Vault
            if (log.address.toLowerCase() !== BALANCER_V3_VAULT) continue
            if (log.topics[0] !== SWAP_TOPIC) continue
            if (!log.topics[1] || !log.topics[2] || !log.topics[3]) continue

            const pool = ('0x' + log.topics[1].slice(26)).toLowerCase()
            const tokenIn = ('0x' + log.topics[2].slice(26)).toLowerCase()
            const tokenOut = ('0x' + log.topics[3].slice(26)).toLowerCase()

            // Decode data: amountIn, amountOut, swapFeePercentage, swapFeeAmount
            const [amountIn, amountOut] = decodeAbiParameters(
                [
                    { type: 'uint256', name: 'amountIn' },
                    { type: 'uint256', name: 'amountOut' },
                    { type: 'uint256', name: 'swapFeePercentage' },
                    { type: 'uint256', name: 'swapFeeAmount' },
                ],
                log.data
            )

            swaps.push({ pool, tokenIn, tokenOut, amountIn, amountOut, poolType: balancerV3.poolType, providerName: balancerV3.name })
        }

        return swaps
    },

    getDirection(_pool: string, _tokenIn: string): boolean {
        // Not used - Balancer V3 specifies tokenIn/tokenOut explicitly
        return true
    },
}
