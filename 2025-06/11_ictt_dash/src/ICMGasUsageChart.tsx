import { useState, useEffect } from "react"
import { getApiGlobalIcmGasUsage } from "./client/sdk.gen"
import { useQuery } from '@tanstack/react-query'
import ExampleCard from "./components/ExampleCard"
import ErrorComponent from "./components/ErrorComponent"
import {
    BarChart,
    Bar,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    Legend,
    ResponsiveContainer
} from 'recharts'

interface MonthData {
    month: string
    [key: string]: number | string // Dynamic keys for chain data
}

// Preset colors from Tailwind
const PRESET_COLORS = {
    hot: [
        '#ef4444', // red-500
        '#f97316', // orange-500
        '#f59e0b', // amber-500
        '#eab308', // yellow-500
        '#f43f5e', // rose-500
        '#fca5a5', // red-300 (for "all others")
    ],
    cold: [
        '#3b82f6', // blue-500
        '#06b6d4', // cyan-500
        '#14b8a6', // teal-500
        '#6366f1', // indigo-500
        '#8b5cf6', // purple-500
        '#93c5fd', // blue-300 (for "all others")
    ]
}

export default function ICMGasUsageChart() {
    const [selectedChain, setSelectedChain] = useState<string>("")
    const [monthsData, setMonthsData] = useState<MonthData[]>([])
    const [chainKeys, setChainKeys] = useState<{ incoming: string[], outgoing: string[] }>({ incoming: [], outgoing: [] })
    const [chainColors, setChainColors] = useState<{ [key: string]: string }>({})
    const [chainNameMap, setChainNameMap] = useState<Map<string, string>>(new Map())

    // Generate timestamps for the last 12 months
    const generateMonthRanges = () => {
        const ranges = []
        const now = new Date()

        for (let i = 11; i >= 0; i--) {
            const date = new Date(now.getFullYear(), now.getMonth() - i, 1)
            const startTs = Math.floor(date.getTime() / 1000)

            const nextMonth = new Date(date.getFullYear(), date.getMonth() + 1, 1)
            const endTs = Math.floor(nextMonth.getTime() / 1000) - 1

            ranges.push({
                startTs,
                endTs,
                month: date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
            })
        }

        return ranges
    }

    const monthRanges = generateMonthRanges()

    // Fetch data for all months
    const { data: allMonthsData, error, isError, isLoading } = useQuery({
        queryKey: ['icmGasUsageChart', monthRanges],
        queryFn: async () => {
            const promises = monthRanges.map(range =>
                getApiGlobalIcmGasUsage({
                    query: { startTs: range.startTs, endTs: range.endTs }
                })
            )

            const results = await Promise.all(promises)
            return results.map((res, index) => ({
                month: monthRanges[index].month,
                data: res.data || []
            }))
        },
        staleTime: 5 * 60 * 1000 // Cache for 5 minutes
    })

    // Extract unique chains from all data
    const uniqueChains = allMonthsData ? Array.from(new Set(
        allMonthsData.flatMap(monthData =>
            monthData.data.map(row => ({
                id: row.chainBlockchainId,
                name: row.chainName
            }))
        ).map(chain => JSON.stringify(chain))
    )).map(str => JSON.parse(str)) : []

    // Set default chain
    useEffect(() => {
        const defaultChainId = '2q9e4r6Mu3U68nU1fYjgbR6JvwrRx36CohpAX5UQxse55x1Q5'
        if (allMonthsData && !selectedChain && uniqueChains.length > 0) {
            const hasDefaultChain = uniqueChains.some(chain => chain.id === defaultChainId)
            if (hasDefaultChain) {
                setSelectedChain(defaultChainId)
            } else {
                const sortedChains = uniqueChains.sort((a, b) => {
                    const aDisplay = a.name === a.id ? a.id : a.name
                    const bDisplay = b.name === b.id ? b.id : b.name
                    return aDisplay.localeCompare(bDisplay)
                })
                setSelectedChain(sortedChains[0].id)
            }
        }
    }, [allMonthsData, selectedChain, uniqueChains])

    // Process data for the selected chain with chain breakdown
    useEffect(() => {
        if (!allMonthsData || !selectedChain) return

        // Collect all unique other chains for the selected chain
        const allOtherChains = new Set<string>()
        const chainNameMap = new Map<string, string>()
        const chainTotals = new Map<string, number>()

        allMonthsData.forEach(monthData => {
            monthData.data
                .filter(row => row.chainBlockchainId === selectedChain)
                .forEach(row => {
                    allOtherChains.add(row.otherChainBlockchainId)
                    chainNameMap.set(row.otherChainBlockchainId, row.otherChainName)

                    // Calculate total gas for ranking
                    const currentTotal = chainTotals.get(row.otherChainBlockchainId) || 0
                    chainTotals.set(row.otherChainBlockchainId, currentTotal + row.receiveGasCost + row.sendGasCost)
                })
        })

        // Sort chains by total gas usage and get top 5
        const sortedChains = Array.from(allOtherChains).sort((a, b) => {
            const totalA = chainTotals.get(a) || 0
            const totalB = chainTotals.get(b) || 0
            return totalB - totalA // Descending order
        })

        const topChains = sortedChains.slice(0, 5)
        const otherChains = sortedChains.slice(5)

        // Create keys for top chains and "all others"
        const incomingKeys = [
            ...topChains.map(id => `in_${id}`),
            ...(otherChains.length > 0 ? ['in_others'] : [])
        ]
        const outgoingKeys = [
            ...topChains.map(id => `out_${id}`),
            ...(otherChains.length > 0 ? ['out_others'] : [])
        ]

        // Use preset colors
        const colors: { [key: string]: string } = {}
        topChains.forEach((chainId, index) => {
            colors[`in_${chainId}`] = PRESET_COLORS.hot[index]
            colors[`out_${chainId}`] = PRESET_COLORS.cold[index]
        })

        // Special color for "all others" - use lighter shade
        if (otherChains.length > 0) {
            colors['in_others'] = PRESET_COLORS.hot[5] // red-300
            colors['out_others'] = PRESET_COLORS.cold[5] // blue-300
            chainNameMap.set('others', 'All Others')
        }

        // Process data by month
        const processedData = allMonthsData.map(monthData => {
            const chainData = monthData.data.filter(row => row.chainBlockchainId === selectedChain)

            const monthEntry: MonthData = { month: monthData.month }

            // Initialize values
            topChains.forEach(chainId => {
                monthEntry[`in_${chainId}`] = 0
                monthEntry[`out_${chainId}`] = 0
            })

            if (otherChains.length > 0) {
                monthEntry['in_others'] = 0
                monthEntry['out_others'] = 0
            }

            // Fill in actual values
            chainData.forEach(row => {
                if (topChains.includes(row.otherChainBlockchainId)) {
                    monthEntry[`in_${row.otherChainBlockchainId}`] = parseFloat(row.receiveGasCost.toFixed(4))
                    monthEntry[`out_${row.otherChainBlockchainId}`] = parseFloat(row.sendGasCost.toFixed(4))
                } else if (otherChains.includes(row.otherChainBlockchainId)) {
                    monthEntry['in_others'] = (monthEntry['in_others'] as number || 0) + parseFloat(row.receiveGasCost.toFixed(4))
                    monthEntry['out_others'] = (monthEntry['out_others'] as number || 0) + parseFloat(row.sendGasCost.toFixed(4))
                }
            })

            return monthEntry
        })

        setMonthsData(processedData)
        setChainKeys({ incoming: incomingKeys, outgoing: outgoingKeys })
        setChainColors(colors)
        setChainNameMap(chainNameMap)
    }, [allMonthsData, selectedChain])

    if (isError) {
        return <ErrorComponent message={error?.message || 'Failed to load ICM gas usage chart data'} />
    }

    return (
        <div className="py-8 px-4 md:px-8">
            <div className="flex flex-col gap-4 mb-8">
                <h1 className="text-3xl font-bold">📈 ICM Gas Usage Over Time</h1>

                <div className="border border-gray-200 rounded-xl bg-white p-6">
                    <div className="mb-3 text-base">Monthly Gas Usage - Top 5 Chains</div>
                    <p className="text-sm mb-3">
                        Visualize gas costs for the top 5 chains by total gas usage over the last 12 months.
                    </p>
                    <ul className="space-y-1 mb-4">
                        <li><span className="font-semibold">Top 5 Chains:</span> Shows the 5 chains with highest total gas usage, all others grouped together</li>
                        <li><span className="font-semibold">Incoming Messages:</span> Gas costs for messages received by the selected chain</li>
                        <li><span className="font-semibold">Outgoing Messages:</span> Gas costs for messages sent from the selected chain</li>
                        <li><span className="font-semibold">Stacking:</span> Incoming messages at bottom, outgoing messages at top</li>
                        <li><span className="font-semibold">Time Period:</span> Last 12 months of activity</li>
                    </ul>

                    <div className="mt-4">
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                            Source Chain
                        </label>
                        <select
                            value={selectedChain}
                            onChange={(e) => setSelectedChain(e.target.value)}
                            className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500"
                        >
                            {uniqueChains.sort((a, b) => {
                                const aDisplay = a.name === a.id ? a.id : a.name
                                const bDisplay = b.name === b.id ? b.id : b.name
                                return aDisplay.localeCompare(bDisplay)
                            }).map(chain => {
                                const display = chain.name === chain.id ? chain.id : chain.name
                                return (
                                    <option key={chain.id} value={chain.id}>
                                        {display}
                                    </option>
                                )
                            })}
                        </select>
                    </div>
                </div>
            </div>

            <ExampleCard
                name="Gas by Chain - Incoming and Outgoing"
                curlString={`# Fetching last 12 months of data\n${monthRanges.slice(0, 2).map(range =>
                    `curl -X GET "${window.location.origin}/api/global/icm-gas-usage?startTs=${range.startTs}&endTs=${range.endTs}"`
                ).join('\n')}\n# ... (10 more requests)`}
            >
                {isLoading ? (
                    <div className="text-center py-8">Loading gas usage chart data...</div>
                ) : !monthsData || monthsData.length === 0 ? (
                    <div className="text-center py-8 text-gray-500">No gas usage data found for the selected chain</div>
                ) : (
                    <div className="h-96">
                        <ResponsiveContainer width="100%" height="100%">
                            <BarChart
                                data={monthsData}
                                margin={{ top: 20, right: 30, left: 20, bottom: 5 }}
                            >
                                <CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" />
                                <XAxis
                                    dataKey="month"
                                    tick={{ fontSize: 12 }}
                                    tickLine={{ stroke: '#666' }}
                                />
                                <YAxis
                                    tick={{ fontSize: 12 }}
                                    tickLine={{ stroke: '#666' }}
                                    label={{
                                        value: 'Gas Cost',
                                        angle: -90,
                                        position: 'insideLeft',
                                        style: { fontSize: 14 }
                                    }}
                                />
                                <Tooltip
                                    formatter={(value: number, name: string) => {
                                        // Extract chain ID from the key (e.g., "in_chainId" -> "chainId")
                                        const chainId = name.replace(/^(in|out)_/, '')
                                        const chainName = chainNameMap.get(chainId) || chainId
                                        const showChainId = chainName === chainId && chainId !== 'others'
                                        const chainDisplay = showChainId ? chainId : chainName
                                        const direction = name.startsWith('in_') ? 'Incoming' : 'Outgoing'
                                        return [value.toFixed(4), `${direction} - ${chainDisplay}`]
                                    }}
                                    contentStyle={{
                                        backgroundColor: 'rgba(255, 255, 255, 0.95)',
                                        border: '1px solid #ccc',
                                        borderRadius: '4px',
                                        maxHeight: '400px',
                                        overflow: 'auto'
                                    }}
                                />
                                <Legend
                                    content={() => null} // Hide legend due to too many items
                                />
                                {/* Render incoming chains first (bottom of stack) */}
                                {chainKeys.incoming.map(key => (
                                    <Bar
                                        key={key}
                                        dataKey={key}
                                        stackId="a"
                                        fill={chainColors[key]}
                                        name={key}
                                    />
                                ))}
                                {/* Then render outgoing chains (top of stack) */}
                                {chainKeys.outgoing.map(key => (
                                    <Bar
                                        key={key}
                                        dataKey={key}
                                        stackId="a"
                                        fill={chainColors[key]}
                                        name={key}
                                    />
                                ))}
                            </BarChart>
                        </ResponsiveContainer>
                    </div>
                )}

                {/* Custom Legend */}
                {monthsData.length > 0 && chainKeys.incoming.length > 0 && (
                    <div className="mt-6 p-4 bg-gray-50 rounded-lg">
                        <h3 className="text-sm font-semibold mb-3">Top 5 Chains by Gas Usage</h3>
                        <div className="grid grid-cols-2 gap-6">
                            {/* Incoming chains */}
                            <div>
                                <h4 className="text-xs font-medium text-gray-600 mb-2">Incoming Messages</h4>
                                <div className="space-y-1">
                                    {chainKeys.incoming.map(key => {
                                        const chainId = key.replace('in_', '')
                                        const chainName = chainNameMap.get(chainId) || chainId
                                        const showChainId = chainName === chainId && chainId !== 'others'
                                        const displayName = showChainId ? chainId : chainName
                                        return (
                                            <div key={key} className="flex items-center gap-2">
                                                <div
                                                    className="w-3 h-3 rounded flex-shrink-0"
                                                    style={{ backgroundColor: chainColors[key] }}
                                                />
                                                <span
                                                    className={`truncate ${showChainId ? 'font-mono text-[10px] text-gray-600' : 'text-xs text-gray-900'} ${chainId === 'others' ? 'italic' : ''}`}
                                                    title={showChainId ? chainId : `${chainName} (${chainId})`}
                                                >
                                                    {displayName}
                                                </span>
                                            </div>
                                        )
                                    })}
                                </div>
                            </div>

                            {/* Outgoing chains */}
                            <div>
                                <h4 className="text-xs font-medium text-gray-600 mb-2">Outgoing Messages</h4>
                                <div className="space-y-1">
                                    {chainKeys.outgoing.map(key => {
                                        const chainId = key.replace('out_', '')
                                        const chainName = chainNameMap.get(chainId) || chainId
                                        const showChainId = chainName === chainId && chainId !== 'others'
                                        const displayName = showChainId ? chainId : chainName
                                        return (
                                            <div key={key} className="flex items-center gap-2">
                                                <div
                                                    className="w-3 h-3 rounded flex-shrink-0"
                                                    style={{ backgroundColor: chainColors[key] }}
                                                />
                                                <span
                                                    className={`truncate ${showChainId ? 'font-mono text-[10px] text-gray-600' : 'text-xs text-gray-900'} ${chainId === 'others' ? 'italic' : ''}`}
                                                    title={showChainId ? chainId : `${chainName} (${chainId})`}
                                                >
                                                    {displayName}
                                                </span>
                                            </div>
                                        )
                                    })}
                                </div>
                            </div>
                        </div>
                    </div>
                )}
            </ExampleCard>
        </div>
    )
}
