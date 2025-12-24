import { useMemo, memo, useState, useEffect } from 'react'
import TimeAgo from 'react-timeago'
import BigNumber from 'bignumber.js'
import { usePriceData } from './PriceContext'
import { type PoolPriceData } from './types'
import { getRate, multiplyRates, formatRate, formatEfficiency, isProfitable, isNearProfitable } from './math'

// Memoized TimeAgo to prevent parent re-renders
const MemoizedTimeAgo = memo(({ date }: { date: number }) => (
    <div className="text-sm text-slate-500">
        Updated <TimeAgo date={date} />
    </div>
))

interface TriRoute {
    id: string
    tokens: [string, string, string] // A, B, C symbols
    hops: [PoolPriceData, PoolPriceData, PoolPriceData] // AB, BC, CA
    rates: [BigNumber, BigNumber, BigNumber]
    efficiency: BigNumber
}

export function TriangularPage() {
    const { prices } = usePriceData()

    // Debounce price updates to avoid recalculating on every WebSocket tick
    const [debouncedPrices, setDebouncedPrices] = useState(prices)
    useEffect(() => {
        const timer = setTimeout(() => setDebouncedPrices(prices), 500)
        return () => clearTimeout(timer)
    }, [prices])

    const routes = useMemo(() => {
        console.time('Triangular calculation')
        const activePrices = Object.values(debouncedPrices).filter(p => !p.error && p.amountOut !== '0')
        if (activePrices.length === 0) {
            console.timeEnd('Triangular calculation')
            return []
        }

        // 1. Build Adjacency Graph: tokenInAddress -> PoolPriceData[]
        const adj = new Map<string, PoolPriceData[]>()
        for (const p of activePrices) {
            const from = p.tokenIn.toLowerCase()
            if (!adj.has(from)) adj.set(from, [])
            adj.get(from)!.push(p)
        }

        const foundRoutes: TriRoute[] = []
        const dedupSet = new Set<string>()

        // 2. Find A -> B -> C -> A
        for (const [tokenA, quotesA] of adj.entries()) {
            for (const hop1 of quotesA) {
                const tokenB = hop1.tokenOut.toLowerCase()
                if (tokenB === tokenA) continue

                const quotesB = adj.get(tokenB)
                if (!quotesB) continue

                for (const hop2 of quotesB) {
                    const tokenC = hop2.tokenOut.toLowerCase()
                    if (tokenC === tokenA || tokenC === tokenB) continue
                    if (hop1.pool === hop2.pool) continue

                    const quotesC = adj.get(tokenC)
                    if (!quotesC) continue

                    for (const hop3 of quotesC) {
                        const tokenEnd = hop3.tokenOut.toLowerCase()
                        if (tokenEnd !== tokenA) continue
                        if (hop3.pool === hop1.pool || hop3.pool === hop2.pool) continue

                        // Found a valid loop - calculate with full precision
                        const r1 = getRate(hop1)
                        const r2 = getRate(hop2)
                        const r3 = getRate(hop3)
                        const efficiency = multiplyRates(r1, r2, r3)

                        // Deduplication by sorted pool IDs
                        const poolSet = [hop1.pool, hop2.pool, hop3.pool].sort().join(':')
                        if (dedupSet.has(poolSet)) continue
                        dedupSet.add(poolSet)

                        foundRoutes.push({
                            id: poolSet,
                            tokens: [hop1.tokenInSymbol, hop2.tokenInSymbol, hop3.tokenInSymbol],
                            hops: [hop1, hop2, hop3],
                            rates: [r1, r2, r3],
                            efficiency
                        })
                    }
                }
            }
        }

        // Sort descending by efficiency (BigNumber comparison)
        foundRoutes.sort((a, b) => b.efficiency.minus(a.efficiency).toNumber())

        console.log(`Found ${foundRoutes.length} triangular routes`)
        console.timeEnd('Triangular calculation')

        // Return top 50 only
        return foundRoutes.slice(0, 50)
    }, [debouncedPrices])

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
                        <p className="text-slate-400">Top 50 loops (A → B → C → A) by efficiency</p>
                    </div>
                    {lastUpdated && <MemoizedTimeAgo date={lastUpdated} />}
                </div>
            </header>

            {routes.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-32 border-2 border-dashed border-slate-800 rounded-3xl">
                    <div className="animate-pulse text-slate-600 font-bold text-lg mb-2">Scanning Loops</div>
                    <div className="text-slate-700 text-sm">Searching for triangular paths...</div>
                </div>
            ) : (
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                    {routes.map((route) => {
                        const effColor = isProfitable(route.efficiency)
                            ? 'text-green-400'
                            : isNearProfitable(route.efficiency)
                                ? 'text-yellow-400'
                                : 'text-slate-500'

                        return (
                            <div key={route.id} className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-5 hover:border-cyan-500/50 transition-all shadow-lg backdrop-blur-sm">
                                <div className="flex justify-between items-start mb-4 border-b border-slate-700/50 pb-3">
                                    <div className="flex items-center gap-2 text-lg font-bold text-white">
                                        <span>{route.tokens[0]}</span>
                                        <span className="text-slate-600">→</span>
                                        <span>{route.tokens[1]}</span>
                                        <span className="text-slate-600">→</span>
                                        <span>{route.tokens[2]}</span>
                                    </div>
                                    <div className={`text-xl font-mono font-black ${effColor}`}>
                                        {formatEfficiency(route.efficiency)}
                                    </div>
                                </div>

                                <div className="space-y-2">
                                    {route.hops.map((hop, i) => (
                                        <div key={i} className="flex items-center justify-between text-sm">
                                            <div className="flex items-center gap-2">
                                                <span className="text-slate-500 font-mono w-4">{i + 1}.</span>
                                                <span className="font-medium text-slate-300">{hop.tokenInSymbol} → {hop.tokenOutSymbol}</span>
                                                <span className="text-[10px] bg-slate-900 text-slate-500 px-1.5 rounded">{hop.providerName}</span>
                                            </div>
                                            <div className="font-mono text-cyan-400">
                                                {formatRate(route.rates[i])}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )
                    })}
                </div>
            )}
        </>
    )
}
