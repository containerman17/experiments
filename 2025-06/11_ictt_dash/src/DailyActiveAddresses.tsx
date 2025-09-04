import { useState, useEffect } from "react"
import { getApiChains, getApiByEvmChainIdStatsDailyActiveAddresses } from "./client/sdk.gen"
import { type GetApiChainsResponses, type GetApiByEvmChainIdStatsDailyActiveAddressesResponses } from "./client/types.gen"
import { useQuery } from '@tanstack/react-query'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import ExampleCard from "./components/ExampleCard"
import ErrorComponent from "./components/ErrorComponent"

type Chain = GetApiChainsResponses[200][0]
type DailyActiveAddressesData = GetApiByEvmChainIdStatsDailyActiveAddressesResponses[200][0]

interface ChartDataPoint {
    date: string
    timestamp: number
    activeAddresses: number
    transactions: number
}

function DailyActiveAddressesChart({ selectedChainId, days }: { selectedChainId: number | null, days: number }) {
    const { data, error, isError, isLoading } = useQuery<DailyActiveAddressesData[]>({
        queryKey: ['dailyActiveAddresses', selectedChainId, days],
        queryFn: async () => {
            if (!selectedChainId) return []
            const res = await getApiByEvmChainIdStatsDailyActiveAddresses({
                path: { evmChainId: String(selectedChainId) },
                query: { days }
            })
            if (res.data) {
                return res.data
            }
            return []
        },
        enabled: !!selectedChainId
    })

    if (isError) {
        return <ErrorComponent message={error?.message || 'Failed to load daily active addresses data'} />
    }

    if (isLoading || !data) {
        return <div className="text-center py-8">Loading daily active addresses data...</div>
    }

    const chartData: ChartDataPoint[] = data.map(item => ({
        date: new Date(item.timestamp * 1000).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric'
        }),
        timestamp: item.timestamp,
        activeAddresses: item.activeAddresses,
        transactions: item.transactions
    })).sort((a, b) => a.timestamp - b.timestamp)

    return (
        <div className="h-96">
            <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 20, right: 50, left: 20, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" />
                    <XAxis
                        dataKey="date"
                        tick={{ fontSize: 12 }}
                        tickLine={{ stroke: '#666' }}
                    />
                    <YAxis
                        yAxisId="left"
                        tick={{ fontSize: 12 }}
                        tickLine={{ stroke: '#666' }}
                        label={{
                            value: 'Active Addresses',
                            angle: -90,
                            position: 'insideLeft',
                            style: { fontSize: 14 }
                        }}
                    />
                    <YAxis
                        yAxisId="right"
                        orientation="right"
                        tick={{ fontSize: 12 }}
                        tickLine={{ stroke: '#666' }}
                        label={{
                            value: 'Transactions',
                            angle: 90,
                            position: 'insideRight',
                            style: { fontSize: 14 }
                        }}
                    />
                    <Tooltip
                        formatter={(value: number, name: string) => {
                            if (name === 'activeAddresses') {
                                return [value.toLocaleString(), 'Active Addresses']
                            }
                            if (name === 'transactions') {
                                return [value.toLocaleString(), 'Transactions']
                            }
                            return [value, name]
                        }}
                        labelFormatter={(label) => `Date: ${label}`}
                        contentStyle={{
                            backgroundColor: 'rgba(255, 255, 255, 0.95)',
                            border: '1px solid #ccc',
                            borderRadius: '4px'
                        }}
                    />
                    <Legend />
                    <Line
                        yAxisId="left"
                        type="monotone"
                        dataKey="activeAddresses"
                        stroke="#3b82f6"
                        strokeWidth={2}
                        dot={false}
                        name="Active Addresses"
                    />
                    <Line
                        yAxisId="right"
                        type="monotone"
                        dataKey="transactions"
                        stroke="#10b981"
                        strokeWidth={2}
                        dot={false}
                        name="Transactions"
                    />
                </LineChart>
            </ResponsiveContainer>
        </div>
    )
}

export default function DailyActiveAddresses() {
    const [selectedChain, setSelectedChain] = useState<number | null>(null)
    const [days, setDays] = useState<number>(365)

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

    // Set default chain
    useEffect(() => {
        const defaultChainId = 43114 // Avalanche C-Chain
        if (chains.length > 0 && selectedChain === null) {
            const hasDefaultChain = chains.some(chain => chain.evmChainId === defaultChainId)
            if (hasDefaultChain) {
                setSelectedChain(defaultChainId)
            } else {
                // Sort chains and select the first one
                const sortedChains = chains.sort((a, b) => a.chainName.localeCompare(b.chainName))
                setSelectedChain(sortedChains[0].evmChainId)
            }
        }
    }, [chains, selectedChain])

    if (chainsIsError) {
        return <ErrorComponent message={chainsError?.message || 'Failed to load chain data'} />
    }

    const handleDaysChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const value = parseInt(event.target.value)
        if (!isNaN(value) && value > 0) {
            setDays(value)
        }
    }

    return (
        <div className="py-8 px-4 md:px-8">
            <div className="flex flex-col gap-4 mb-8">
                <h1 className="text-3xl font-bold">📊 Daily Active Addresses</h1>

                <div className="border border-gray-200 rounded-xl bg-white p-6">
                    <div className="mb-3 text-base">Daily Active Addresses by Chain</div>
                    <p className="text-sm mb-3">
                        Track the number of unique addresses that transacted on a specific chain each day.
                    </p>
                    <ul className="space-y-1 mb-4">
                        <li><span className="font-semibold">Active Addresses:</span> Number of unique addresses that made at least one transaction on a given day</li>
                        <li><span className="font-semibold">Transactions:</span> Total number of transactions processed on that day</li>
                        <li><span className="font-semibold">Time Period:</span> Configurable number of days to display (up to available data)</li>
                        <li><span className="font-semibold">Chain Selection:</span> Choose any indexed L1 chain to view its daily activity</li>
                    </ul>

                    <div className="flex flex-col gap-4">
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                                Chain
                            </label>
                            <select
                                value={selectedChain || ''}
                                onChange={(e) => setSelectedChain(Number(e.target.value))}
                                className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500"
                            >
                                <option value="">Select a chain...</option>
                                {chains.map(chain => (
                                    <option key={chain.evmChainId} value={chain.evmChainId}>
                                        {chain.chainName}
                                    </option>
                                ))}
                            </select>
                        </div>

                        <div className="max-w-xs">
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                                Number of Days
                            </label>
                            <input
                                type="number"
                                value={days}
                                onChange={handleDaysChange}
                                min="1"
                                max="365"
                                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                                placeholder="Days to display"
                            />
                        </div>
                    </div>
                </div>
            </div>

            <ExampleCard
                name="Daily Active Addresses Chart"
                curlString={selectedChain ? `curl -X GET "${window.location.origin}/api/${selectedChain}/stats/daily-active-addresses?days=${days}"` : `curl -X GET "${window.location.origin}/api/{chainId}/stats/daily-active-addresses?days=${days}"`}
            >
                <DailyActiveAddressesChart selectedChainId={selectedChain} days={days} />
            </ExampleCard>
        </div>
    )
}
