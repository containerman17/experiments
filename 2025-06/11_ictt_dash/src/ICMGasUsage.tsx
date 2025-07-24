import { useState } from "react"
import { getApiChains, getApiByEvmChainIdStatsIcmGasUsage } from "./client/sdk.gen"
import { type GetApiChainsResponses, type GetApiByEvmChainIdStatsIcmGasUsageResponses } from "./client/types.gen"
import { useQuery } from '@tanstack/react-query'
import ExampleCard from "./components/ExampleCard"
import ErrorComponent from "./components/ErrorComponent"
import ChainSelector from "./components/ChainSelector"
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'

type Chain = GetApiChainsResponses[200][0]
type ICMGasUsageData = GetApiByEvmChainIdStatsIcmGasUsageResponses[200]

interface ChartDataPoint {
    time: string
    timestamp: number
    [key: string]: number | string
}

const CHAIN_COLORS = [
    '#3B82F6', // blue-500
    '#EF4444', // red-500
    '#10B981', // emerald-500
    '#F59E0B', // amber-500
    '#8B5CF6', // violet-500
    '#EC4899', // pink-500
    '#14B8A6', // teal-500
    '#F97316', // orange-500
    '#6366F1', // indigo-500
    '#84CC16', // lime-500
]

function ICMGasUsageChart({ selectedChainId }: { selectedChainId: number | null }) {
    const { data: gasUsageData, isLoading, error } = useQuery({
        queryKey: ['icm-gas-usage', selectedChainId],
        queryFn: async () => {
            if (!selectedChainId) return null
            const res = await getApiByEvmChainIdStatsIcmGasUsage({
                path: { evmChainId: String(selectedChainId) },
                query: { period: '1d', count: 30 }
            })
            return res.data
        },
        enabled: !!selectedChainId
    })

    const formatTime = (timestamp: number): string => {
        return new Date(timestamp * 1000).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric'
        })
    }

    const transformDataForChart = (data: ICMGasUsageData): ChartDataPoint[] => {
        if (!data) return []

        // Include all time periods
        const timePoints = new Set<number>()
        Object.values(data).forEach(chain => {
            chain.values.forEach(value => timePoints.add(value.intervalTs))
        })

        const sortedTimePoints = Array.from(timePoints).sort((a, b) => a - b)

        return sortedTimePoints.map(timestamp => {
            const dataPoint: ChartDataPoint = {
                time: formatTime(timestamp),
                timestamp
            }

            Object.entries(data).forEach(([chainId, chainData]) => {
                const value = chainData.values.find(v => v.intervalTs === timestamp)
                const sendKey = `${chainData.name}_${chainId}_send`
                const receiveKey = `${chainData.name}_${chainId}_receive`

                dataPoint[sendKey] = value?.sendGasCost || 0
                dataPoint[receiveKey] = value?.receiveGasCost || 0
            })

            return dataPoint
        })
    }

    const chartData = transformDataForChart(gasUsageData || {})

    if (error) {
        return <div className="text-center py-8 text-red-600">Error loading gas usage data</div>
    }

    if (isLoading) {
        return <div className="text-center py-8">Loading gas usage data...</div>
    }

    if (!gasUsageData || Object.keys(gasUsageData).length === 0) {
        return <div className="text-center py-8 text-gray-500">No gas usage data available</div>
    }

    return (
        <div className="h-96">
            <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis
                        dataKey="time"
                        tick={{ fontSize: 12 }}
                        interval="preserveStartEnd"
                    />
                    <YAxis
                        tick={{ fontSize: 12 }}
                        label={{ value: 'Gas Cost (Native Token)', angle: -90, position: 'insideLeft' }}
                        domain={[0, 'dataMax']}
                    />
                    <Tooltip
                        formatter={(value: number, name: string) => [
                            `${Number(value).toFixed(2)} Native Token`,
                            name.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase())
                        ]}
                        labelFormatter={(label: string) => `Time: ${label}`}
                    />
                    <Legend />
                    {Object.entries(gasUsageData || {})
                        .filter(([, chain]) => {
                            // Only show chains that have actual data
                            return chain.values.some(v => v.sendGasCost > 0 || v.receiveGasCost > 0)
                        })
                        .map(([chainId, chain], index) => {
                            const colorIndex = index % CHAIN_COLORS.length
                            const sendColor = CHAIN_COLORS[colorIndex]
                            const receiveColor = CHAIN_COLORS[colorIndex] + '80' // Add transparency
                            const sendKey = `${chain.name}_${chainId}_send`
                            const receiveKey = `${chain.name}_${chainId}_receive`

                            return [
                                <Bar
                                    key={sendKey}
                                    dataKey={sendKey}
                                    stackId={chainId}
                                    fill={sendColor}
                                    name={`${chain.name} Send`}
                                />,
                                <Bar
                                    key={receiveKey}
                                    dataKey={receiveKey}
                                    stackId={chainId}
                                    fill={receiveColor}
                                    name={`${chain.name} Receive`}
                                />
                            ]
                        }).flat()}
                </BarChart>
            </ResponsiveContainer>
        </div>
    )
}

export default function ICMGasUsage() {
    const [selectedChainId, setSelectedChainId] = useState<number | null>(null)

    const { data: chains = [], error, isError } = useQuery<Chain[]>({
        queryKey: ['chains'],
        queryFn: async () => {
            const res = await getApiChains()
            if (res.data) {
                return res.data.sort((a, b) => a.chainName.localeCompare(b.chainName))
            }
            throw new Error('Failed to fetch chains')
        }
    })

    if (isError) {
        return <ErrorComponent message={error?.message || 'Failed to load chain data'} />
    }

    return (
        <div className="py-8 px-4 md:px-8">
            <div className="flex flex-col gap-4 mb-8">
                <h1 className="text-3xl font-bold">📊 ICM Gas Usage</h1>

                <div className="border border-gray-200 rounded-xl bg-white p-6">
                    <div className="mb-3 text-base">Inter-Chain Messaging Gas Usage</div>
                    <p className="text-sm mb-3">
                        Track gas costs for sending and receiving cross-chain messages over time:
                    </p>
                    <ul className="space-y-1 mb-3">
                        <li><span className="font-semibold">Send Gas Cost:</span> Gas used to send messages to other chains</li>
                        <li><span className="font-semibold">Receive Gas Cost:</span> Gas used to receive messages from other chains</li>
                        <li><span className="font-semibold">Time Intervals:</span> Data aggregated in 5-minute intervals</li>
                        <li><span className="font-semibold">Units:</span> All costs displayed in native token for selected chain</li>
                    </ul>
                </div>

                <ChainSelector
                    chains={chains}
                    selectedChainId={selectedChainId}
                    onChainSelect={setSelectedChainId}
                    defaultChainId={779672}
                />
            </div>

            <div className="grid grid-cols-1">
                <ExampleCard
                    name="ICM Gas Usage Chart"
                    curlString={`curl -X GET ${window.location.origin}/api/${selectedChainId || '{evmChainId}'}/stats/icm-gas-usage?period=7d&count=50`}
                >
                    <ICMGasUsageChart selectedChainId={selectedChainId} />
                </ExampleCard>
            </div>
        </div>
    )
}
