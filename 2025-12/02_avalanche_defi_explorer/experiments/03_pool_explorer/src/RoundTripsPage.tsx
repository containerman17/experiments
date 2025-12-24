import { useMemo } from 'react'
import TimeAgo from 'react-timeago'
import BigNumber from 'bignumber.js'
import { usePriceData } from './PriceContext'
import { type PoolPriceData } from './types'
import { getRate, multiplyRates, formatRate, formatEfficiency, isProfitable, isNearProfitable } from './math'

interface RoundTrip {
    tokenA: string
    tokenASymbol: string
    tokenB: string
    tokenBSymbol: string
    forward: PoolPriceData   // best A→B
    reverse: PoolPriceData   // best B→A
    forwardRate: BigNumber
    reverseRate: BigNumber
    efficiency: BigNumber    // 1.0 = break-even
}

export function RoundTripsPage() {
    const { prices } = usePriceData()

    const roundTrips = useMemo(() => {
        const priceList = Object.values(prices).filter(p => !p.error && p.amountOut !== '0')

        // Build pair map: sorted key -> quotes
        const pairMap = new Map<string, PoolPriceData[]>()
        for (const quote of priceList) {
            const [a, b] = [quote.tokenIn.toLowerCase(), quote.tokenOut.toLowerCase()].sort()
            const key = `${a}:${b}`
            if (!pairMap.has(key)) pairMap.set(key, [])
            pairMap.get(key)!.push(quote)
        }

        const results: RoundTrip[] = []

        for (const [key, quotes] of pairMap) {
            const [tokenA, tokenB] = key.split(':')

            // Separate by direction
            const forward = quotes.filter(q => q.tokenIn.toLowerCase() === tokenA)
            const reverse = quotes.filter(q => q.tokenIn.toLowerCase() === tokenB)

            if (forward.length === 0 || reverse.length === 0) continue

            // Calculate rates with full precision
            const forwardWithRates = forward.map(q => ({ quote: q, rate: getRate(q) }))
            const reverseWithRates = reverse.map(q => ({ quote: q, rate: getRate(q) }))

            // Pick best rate for each direction
            const bestForward = forwardWithRates.reduce((a, b) => a.rate.gt(b.rate) ? a : b)
            const bestReverse = reverseWithRates.reduce((a, b) => a.rate.gt(b.rate) ? a : b)

            // Compute efficiency with full precision
            const efficiency = multiplyRates(bestForward.rate, bestReverse.rate)

            results.push({
                tokenA,
                tokenASymbol: bestForward.quote.tokenInSymbol,
                tokenB,
                tokenBSymbol: bestForward.quote.tokenOutSymbol,
                forward: bestForward.quote,
                reverse: bestReverse.quote,
                forwardRate: bestForward.rate,
                reverseRate: bestReverse.rate,
                efficiency
            })
        }

        // Sort by efficiency descending (BigNumber comparison)
        results.sort((a, b) => b.efficiency.minus(a.efficiency).toNumber())
        return results
    }, [prices])

    const lastUpdated = useMemo(() => {
        const all = Object.values(prices)
        if (all.length === 0) return null
        return Math.max(...all.map(p => p.updatedAt))
    }, [prices])

    return (
        <>
            <header className="mb-8 border-b border-slate-800 pb-6">
                <div className="flex items-center justify-between">
                    <div>
                        <h1 className="text-4xl font-black tracking-tight text-white mb-2">Round Trips</h1>
                        <p className="text-slate-400">Best round-trip efficiency for each token pair (A→B→A)</p>
                    </div>
                    {lastUpdated && (
                        <div className="text-sm text-slate-500">
                            Updated <TimeAgo date={lastUpdated} />
                        </div>
                    )}
                </div>
            </header>

            {roundTrips.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-32 border-2 border-dashed border-slate-800 rounded-3xl">
                    <div className="animate-pulse text-slate-600 font-bold text-lg mb-2">Syncing Data</div>
                    <div className="text-slate-700 text-sm">Waiting for price quotes...</div>
                </div>
            ) : (
                <div className="overflow-x-auto rounded-xl border border-slate-700/50">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="bg-slate-800/80 text-slate-400 uppercase text-xs tracking-wider">
                                <th className="text-left px-4 py-3 font-medium">Pair</th>
                                <th className="text-left px-4 py-3 font-medium">Forward Pool</th>
                                <th className="text-right px-4 py-3 font-medium">A→B Rate</th>
                                <th className="text-left px-4 py-3 font-medium">Reverse Pool</th>
                                <th className="text-right px-4 py-3 font-medium">B→A Rate</th>
                                <th className="text-right px-4 py-3 font-medium">Efficiency</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800">
                            {roundTrips.map((rt, i) => {
                                const effColor = isProfitable(rt.efficiency)
                                    ? 'text-green-400'
                                    : isNearProfitable(rt.efficiency)
                                        ? 'text-yellow-400'
                                        : isNearProfitable(rt.efficiency, 0.95)
                                            ? 'text-orange-400'
                                            : 'text-red-400'
                                return (
                                    <tr key={i} className="hover:bg-slate-800/30 transition-colors">
                                        <td className="px-4 py-3">
                                            <span className="font-bold text-white">{rt.tokenASymbol}</span>
                                            <span className="text-slate-500 mx-1">⇄</span>
                                            <span className="font-bold text-white">{rt.tokenBSymbol}</span>
                                        </td>
                                        <td className="px-4 py-3">
                                            <div className="text-xs text-slate-500 font-mono">
                                                {rt.forward.pool.slice(0, 8)}...
                                            </div>
                                            <div className="text-[10px] text-slate-600">{rt.forward.providerName}</div>
                                        </td>
                                        <td className="px-4 py-3 text-right font-mono text-cyan-400">
                                            {formatRate(rt.forwardRate)}
                                        </td>
                                        <td className="px-4 py-3">
                                            <div className="text-xs text-slate-500 font-mono">
                                                {rt.reverse.pool.slice(0, 8)}...
                                            </div>
                                            <div className="text-[10px] text-slate-600">{rt.reverse.providerName}</div>
                                        </td>
                                        <td className="px-4 py-3 text-right font-mono text-cyan-400">
                                            {formatRate(rt.reverseRate)}
                                        </td>
                                        <td className={`px-4 py-3 text-right font-mono font-bold ${effColor}`}>
                                            {formatEfficiency(rt.efficiency)}
                                        </td>
                                    </tr>
                                )
                            })}
                        </tbody>
                    </table>
                </div>
            )}
        </>
    )
}
