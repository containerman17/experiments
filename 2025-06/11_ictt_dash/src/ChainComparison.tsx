import { useState, useEffect } from "react"
import { getApiChains, getApiByEvmChainIdStatsCumulativeTxs, getApiByEvmChainIdStatsActiveAddressesPeriod } from "./client/sdk.gen"
import { type GetApiChainsResponses } from "./client/types.gen"
import { useQuery } from '@tanstack/react-query'
import ErrorComponent from "./components/ErrorComponent"

type Chain = GetApiChainsResponses[200][0]

interface ChainStats {
    chain: Chain
    period1: {
        totalTxs: number
        dailyTxs: number
        totalActiveAddresses: number
        avgDailyActiveAddresses: number
    }
    period2: {
        totalTxs: number
        dailyTxs: number
        totalActiveAddresses: number
        avgDailyActiveAddresses: number
    }
    loading: boolean
    error?: string
}

export default function ChainComparison() {
    // Default dates as Unix timestamps
    const [period1Start] = useState<number>(Math.floor(new Date('2025-03-15').getTime() / 1000))
    const [period1End] = useState<number>(Math.floor(new Date('2025-04-15').getTime() / 1000))
    const [period2Start] = useState<number>(Math.floor(new Date('2025-06-15').getTime() / 1000))
    const [period2End] = useState<number>(Math.floor(new Date('2025-07-15').getTime() / 1000))

    const [selectedChains, setSelectedChains] = useState<Set<number>>(new Set([
        235235, 16180, 379, 8198, 6533, 4313, 13790, 27827, 8021, 50776, 5506, 12150, 741741
    ]))
    const [chainStats, setChainStats] = useState<Map<number, ChainStats>>(new Map())

    const { data: chains = [], error: chainsError, isError: chainsIsError } = useQuery<Chain[]>({
        queryKey: ['chains'],
        queryFn: async () => {
            const res = await getApiChains()
            if (res.data) {
                return res.data.sort((a, b) => a.chainName.localeCompare(b.chainName))
            }
            throw new Error('Failed to fetch chains')
        }
    })

    const toggleChain = (evmChainId: number) => {
        const newSelected = new Set(selectedChains)
        if (newSelected.has(evmChainId)) {
            newSelected.delete(evmChainId)
            const newStats = new Map(chainStats)
            newStats.delete(evmChainId)
            setChainStats(newStats)
        } else {
            newSelected.add(evmChainId)
        }
        setSelectedChains(newSelected)
    }

    // Fetch stats for selected chains
    useEffect(() => {
        const fetchStats = async (chain: Chain) => {
            setChainStats(prev => new Map(prev).set(chain.evmChainId, {
                chain,
                period1: { totalTxs: 0, dailyTxs: 0, totalActiveAddresses: 0, avgDailyActiveAddresses: 0 },
                period2: { totalTxs: 0, dailyTxs: 0, totalActiveAddresses: 0, avgDailyActiveAddresses: 0 },
                loading: true
            }))

            try {
                // Fetch cumulative txs and active addresses data in parallel
                const [p1Start, p1End, p2Start, p2End, p1ActiveAddresses, p2ActiveAddresses] = await Promise.all([
                    getApiByEvmChainIdStatsCumulativeTxs({
                        path: { evmChainId: String(chain.evmChainId) },
                        query: { timestamp: period1Start }
                    }),
                    getApiByEvmChainIdStatsCumulativeTxs({
                        path: { evmChainId: String(chain.evmChainId) },
                        query: { timestamp: period1End }
                    }),
                    getApiByEvmChainIdStatsCumulativeTxs({
                        path: { evmChainId: String(chain.evmChainId) },
                        query: { timestamp: period2Start }
                    }),
                    getApiByEvmChainIdStatsCumulativeTxs({
                        path: { evmChainId: String(chain.evmChainId) },
                        query: { timestamp: period2End }
                    }),
                    // Fetch active addresses for period 1
                    getApiByEvmChainIdStatsActiveAddressesPeriod({
                        path: { evmChainId: String(chain.evmChainId) },
                        query: { startTimestamp: period1Start, endTimestamp: period1End }
                    }).then(res => res.data || { totalActiveAddresses: 0, avgDailyActiveAddresses: 0, totalTransactions: 0 })
                        .catch(() => ({ totalActiveAddresses: 0, avgDailyActiveAddresses: 0, totalTransactions: 0 })),
                    // Fetch active addresses for period 2
                    getApiByEvmChainIdStatsActiveAddressesPeriod({
                        path: { evmChainId: String(chain.evmChainId) },
                        query: { startTimestamp: period2Start, endTimestamp: period2End }
                    }).then(res => res.data || { totalActiveAddresses: 0, avgDailyActiveAddresses: 0, totalTransactions: 0 })
                        .catch(() => ({ totalActiveAddresses: 0, avgDailyActiveAddresses: 0, totalTransactions: 0 }))
                ])

                const period1StartTxs = p1Start.data?.cumulativeTxs || 0
                const period1TotalTxs = p1End.data?.cumulativeTxs || 0
                const period2StartTxs = p2Start.data?.cumulativeTxs || 0
                const period2TotalTxs = p2End.data?.cumulativeTxs || 0

                const period1TxsInPeriod = period1TotalTxs - period1StartTxs
                const period2TxsInPeriod = period2TotalTxs - period2StartTxs

                const period1Days = Math.ceil((period1End - period1Start) / 86400)
                const period2Days = Math.ceil((period2End - period2Start) / 86400)

                console.log(`Chain ${chain.evmChainId}:`, {
                    period1: { start: period1StartTxs, end: period1TotalTxs, diff: period1TxsInPeriod, days: period1Days },
                    period2: { start: period2StartTxs, end: period2TotalTxs, diff: period2TxsInPeriod, days: period2Days }
                })

                setChainStats(prev => new Map(prev).set(chain.evmChainId, {
                    chain,
                    period1: {
                        totalTxs: period1TotalTxs,
                        dailyTxs: period1TxsInPeriod / period1Days,
                        totalActiveAddresses: p1ActiveAddresses.totalActiveAddresses || 0,
                        avgDailyActiveAddresses: p1ActiveAddresses.avgDailyActiveAddresses || 0
                    },
                    period2: {
                        totalTxs: period2TotalTxs,
                        dailyTxs: period2TxsInPeriod / period2Days,
                        totalActiveAddresses: p2ActiveAddresses.totalActiveAddresses || 0,
                        avgDailyActiveAddresses: p2ActiveAddresses.avgDailyActiveAddresses || 0
                    },
                    loading: false
                }))
            } catch (error) {
                setChainStats(prev => new Map(prev).set(chain.evmChainId, {
                    chain,
                    period1: { totalTxs: 0, dailyTxs: 0, totalActiveAddresses: 0, avgDailyActiveAddresses: 0 },
                    period2: { totalTxs: 0, dailyTxs: 0, totalActiveAddresses: 0, avgDailyActiveAddresses: 0 },
                    loading: false,
                    error: error instanceof Error ? error.message : 'Failed to fetch data'
                }))
            }
        }

        // Fetch stats for newly selected chains
        selectedChains.forEach(evmChainId => {
            if (!chainStats.has(evmChainId)) {
                const chain = chains.find(c => c.evmChainId === evmChainId)
                if (chain) {
                    fetchStats(chain)
                }
            }
        })
    }, [selectedChains, chains, chainStats, period1Start, period1End, period2Start, period2End])

    if (chainsIsError) {
        return <ErrorComponent message={chainsError?.message || 'Failed to load chain data'} />
    }

    const formatDate = (timestamp: number): string => {
        return new Date(timestamp * 1000).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
        })
    }

    return (
        <div className="py-8 px-4 md:px-8">
            <h1 className="text-3xl font-bold mb-6">📊 Chain Comparison Dashboard</h1>

            {/* Period Settings */}
            <div className="bg-white border border-gray-200 rounded-xl p-6 mb-6">
                <h2 className="text-xl font-semibold mb-4">Period Settings</h2>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div>
                        <h3 className="font-medium mb-2">Period 1</h3>
                        <p className="text-sm text-gray-600">
                            {formatDate(period1Start)} - {formatDate(period1End)}
                        </p>
                    </div>
                    <div>
                        <h3 className="font-medium mb-2">Period 2</h3>
                        <p className="text-sm text-gray-600">
                            {formatDate(period2Start)} - {formatDate(period2End)}
                        </p>
                    </div>
                </div>
            </div>

            {/* Chain Selection */}
            <div className="bg-white border border-gray-200 rounded-xl p-6 mb-6">
                <h2 className="text-xl font-semibold mb-4">Select Chains</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                    {chains.map(chain => (
                        <label
                            key={chain.evmChainId}
                            className="flex items-center space-x-2 cursor-pointer hover:bg-gray-50 p-2 rounded"
                        >
                            <input
                                type="checkbox"
                                checked={selectedChains.has(chain.evmChainId)}
                                onChange={() => toggleChain(chain.evmChainId)}
                                className="h-4 w-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500"
                            />
                            <span className="text-sm">
                                {chain.chainName}
                                <span className="text-xs text-gray-500 ml-1">({chain.evmChainId})</span>
                            </span>
                        </label>
                    ))}
                </div>
            </div>

            {/* Chain Stats Cards */}
            <div className="space-y-4">
                {Array.from(selectedChains).map(evmChainId => {
                    const stats = chainStats.get(evmChainId)
                    if (!stats) return null

                    return (
                        <div key={evmChainId} className="bg-white border border-gray-200 rounded-xl p-6">
                            <h3 className="text-lg font-semibold mb-4">
                                {stats.chain.chainName}
                                <span className="text-sm text-gray-500 ml-2">Chain ID: {evmChainId}</span>
                            </h3>

                            {stats.loading ? (
                                <div className="text-center py-8 text-gray-500">Loading stats...</div>
                            ) : stats.error ? (
                                <div className="text-center py-8 text-red-500">Error: {stats.error}</div>
                            ) : (
                                <div className="overflow-x-auto">
                                    <table className="w-full">
                                        <thead>
                                            <tr className="border-b">
                                                <th className="text-left py-2 px-4">Metric</th>
                                                <th className="text-right py-2 px-4">Period 1</th>
                                                <th className="text-right py-2 px-4">Period 2</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            <tr className="border-b">
                                                <td className="py-3 px-4">Total Transactions (end of period)</td>
                                                <td className="text-right py-3 px-4 font-mono">
                                                    {stats.period1.totalTxs.toLocaleString()}
                                                </td>
                                                <td className="text-right py-3 px-4 font-mono">
                                                    {stats.period2.totalTxs.toLocaleString()}
                                                </td>
                                            </tr>
                                            <tr className="border-b">
                                                <td className="py-3 px-4">Daily Transactions (avg)</td>
                                                <td className="text-right py-3 px-4 font-mono">
                                                    {Math.round(stats.period1.dailyTxs).toLocaleString()}
                                                </td>
                                                <td className="text-right py-3 px-4 font-mono">
                                                    {Math.round(stats.period2.dailyTxs).toLocaleString()}
                                                </td>
                                            </tr>
                                            <tr className="border-b">
                                                <td className="py-3 px-4">Active Addresses (total)</td>
                                                <td className="text-right py-3 px-4 font-mono">
                                                    {stats.period1.totalActiveAddresses.toLocaleString()}
                                                </td>
                                                <td className="text-right py-3 px-4 font-mono">
                                                    {stats.period2.totalActiveAddresses.toLocaleString()}
                                                </td>
                                            </tr>
                                            <tr className="border-b">
                                                <td className="py-3 px-4">Daily Active Users (avg)</td>
                                                <td className="text-right py-3 px-4 font-mono">
                                                    {Math.round(stats.period1.avgDailyActiveAddresses).toLocaleString()}
                                                </td>
                                                <td className="text-right py-3 px-4 font-mono">
                                                    {Math.round(stats.period2.avgDailyActiveAddresses).toLocaleString()}
                                                </td>
                                            </tr>
                                            <tr className="text-sm text-gray-500">
                                                <td className="py-2 px-4" colSpan={3}>
                                                    More metrics coming soon: gas usage, ICM messages
                                                </td>
                                            </tr>
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </div>
                    )
                })}

                {selectedChains.size === 0 && (
                    <div className="text-center py-12 text-gray-500">
                        Select chains above to view their statistics
                    </div>
                )}
            </div>
        </div>
    )
}
