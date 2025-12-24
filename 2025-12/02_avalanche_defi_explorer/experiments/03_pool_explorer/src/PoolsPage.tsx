import TimeAgo from 'react-timeago'
import { type PoolPriceData, getPriceKey } from './types'
import { usePriceData } from './PriceContext'

export function PoolsPage() {
    const { prices } = usePriceData()

    // Grouping for display: Provider -> Pool -> Quotes
    const grouped = Object.values(prices).reduce((acc, p) => {
        if (!acc[p.providerName]) acc[p.providerName] = {}
        if (!acc[p.providerName][p.pool]) acc[p.providerName][p.pool] = []
        acc[p.providerName][p.pool].push(p)
        return acc
    }, {} as Record<string, Record<string, PoolPriceData[]>>)

    const formatRate = (p: PoolPriceData) => {
        const valIn = Number(p.amountIn) / 10 ** p.tokenInDecimals
        const valOut = Number(p.amountOut) / 10 ** p.tokenOutDecimals
        if (valOut === 0) return '---'
        const rate = valOut / valIn
        const inverse = valIn / valOut
        return `${rate.toFixed(6)} / ${inverse.toFixed(6)}`
    }

    return (
        <>
            <header className="mb-12 border-b border-slate-800 pb-6">
                <h1 className="text-4xl font-black tracking-tight text-white mb-2">Pools</h1>
                <p className="text-slate-400">Real-time price feed from Avalanche DeFi pools</p>
            </header>

            <div className="space-y-12">
                {Object.entries(grouped).map(([provider, pools]) => (
                    <section key={provider}>
                        <h2 className="text-xl font-bold text-cyan-400 mb-6 uppercase tracking-widest">{provider}</h2>

                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-6">
                            {Object.entries(pools).map(([address, quotes]) => {
                                const lastUpdated = Math.max(...quotes.map(q => q.updatedAt))

                                return (
                                    <div key={address} className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-5 hover:border-cyan-500/50 transition-all shadow-xl backdrop-blur-sm">
                                        <div className="flex justify-between items-center mb-4">
                                            <span className="text-[10px] font-mono text-slate-500 bg-slate-900 px-2 py-1 rounded">
                                                {address.slice(0, 10)}...{address.slice(-8)}
                                            </span>
                                            <span className="text-[10px] text-slate-500">
                                                <TimeAgo date={lastUpdated} />
                                            </span>
                                        </div>

                                        <div className="space-y-3">
                                            {quotes.map((q) => {
                                                const isError = q.error || q.amountOut === '0'
                                                return (
                                                    <div key={getPriceKey(q)} className={`flex items-center justify-between group ${isError ? 'opacity-30' : ''}`}>
                                                        <div className="flex items-center gap-1.5 min-w-0">
                                                            <span className="font-bold text-sm truncate">{q.tokenInSymbol}</span>
                                                            <span className="text-slate-600 text-[10px]">→</span>
                                                            <span className="font-bold text-sm truncate">{q.tokenOutSymbol}</span>
                                                        </div>
                                                        <div className={`font-mono text-sm tabular-nums transition-colors ${isError ? 'text-slate-500' : 'text-cyan-400 group-hover:text-cyan-300'}`}>
                                                            {formatRate(q)}
                                                        </div>
                                                    </div>
                                                )
                                            })}
                                        </div>
                                    </div>
                                )
                            })}
                        </div>
                    </section>
                ))}

                {Object.keys(grouped).length === 0 && (
                    <div className="flex flex-col items-center justify-center py-32 border-2 border-dashed border-slate-800 rounded-3xl">
                        <div className="animate-pulse text-slate-600 font-bold text-lg mb-2">Syncing Data</div>
                        <div className="text-slate-700 text-sm">Monitoring blockchain for swaps...</div>
                    </div>
                )}
            </div>
        </>
    )
}
