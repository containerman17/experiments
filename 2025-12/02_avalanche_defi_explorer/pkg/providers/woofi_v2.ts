import { type Log, decodeAbiParameters, keccak256, toHex } from 'viem'
import { type PoolProvider, type SwapEvent, type CachedRPC, POOL_TYPE_WOOFI } from './_types.ts'


const WOOFI_ROUTER = '0x4c4af8dbc524681930a27b2f1af5bcc8062e6fb7'

// WooRouterSwap(uint8 swapType, address indexed fromToken, address indexed toToken, uint256 fromAmount, uint256 toAmount, address from, address indexed to, address rebateTo)
const WOO_SWAP_TOPIC = keccak256(toHex('WooRouterSwap(uint8,address,address,uint256,uint256,address,address,address)'))

export const woofiV2: PoolProvider = {
    name: 'woofi_v2',
    poolType: POOL_TYPE_WOOFI,
    topics: [WOO_SWAP_TOPIC],

    async processLogs(logs: Log[], _cachedRPC: CachedRPC): Promise<SwapEvent[]> {
        const swaps: SwapEvent[] = []

        for (const log of logs) {
            if (log.topics[0] !== WOO_SWAP_TOPIC) continue
            if (log.address.toLowerCase() !== WOOFI_ROUTER) continue

            // Indexed topics: fromToken, toToken, to
            const fromToken = ('0x' + log.topics[1]!.slice(26)).toLowerCase()
            const toToken = ('0x' + log.topics[2]!.slice(26)).toLowerCase()

            // Decode non-indexed: uint8 swapType, uint256 fromAmount, uint256 toAmount, address from, address rebateTo
            const [, fromAmount, toAmount] = decodeAbiParameters(
                [
                    { type: 'uint8', name: 'swapType' },
                    { type: 'uint256', name: 'fromAmount' },
                    { type: 'uint256', name: 'toAmount' },
                    { type: 'address', name: 'from' },
                    { type: 'address', name: 'rebateTo' },
                ],
                log.data
            )

            if (fromAmount <= 0n || toAmount <= 0n) continue

            // WOOFi uses the router as the "pool" address
            swaps.push({
                pool: WOOFI_ROUTER,
                tokenIn: fromToken,
                tokenOut: toToken,
                amountIn: fromAmount,
                amountOut: toAmount,
                poolType: woofiV2.poolType,
                providerName: woofiV2.name,
            })
        }

        return swaps
    },

    getDirection(_pool: string, _tokenIn: string): boolean {
        // WOOFi doesn't use direction - tokens are specified directly
        return true
    },
}
