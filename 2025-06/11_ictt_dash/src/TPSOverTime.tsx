import { useState } from "react"
import { getApiChains, getApiByChainIdStatsTps } from "./client/sdk.gen"
import { type GetApiChainsResponses, type GetApiByChainIdStatsTpsResponses } from "./client/types.gen"
import { useQuery } from '@tanstack/react-query'
import ExampleCard from "./components/ExampleCard"
import ErrorComponent from "./components/ErrorComponent"
import ChainSelector from "./components/ChainSelector"
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'

type Chain = GetApiChainsResponses[200][0]
type TPSData = GetApiByChainIdStatsTpsResponses[200]

interface ChartDataPoint {
    time: string
    timestamp: number
    tps: number
}

function TPSChart({ selectedChainId }: { selectedChainId: number | null }) {
    const { data: tpsData, isLoading, error } = useQuery({
        queryKey: ['tps', selectedChainId],
        queryFn: async () => {
            if (!selectedChainId) return null
            const res = await getApiByChainIdStatsTps({
                path: { chainId: String(selectedChainId) },
                query: { count: 30 }
            })
            return res.data
        },
        enabled: !!selectedChainId
    })

    const formatTime = (timestamp: number): string => {
        const date = new Date(timestamp * 1000)
        if (isNaN(date.getTime())) {
            return 'Invalid Date'
        }
        return date.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric'
        })
    }

    const transformDataForChart = (data: TPSData): ChartDataPoint[] => {
        if (!data) return []

        return data.map(point => ({
            time: formatTime(point.timestamp),
            timestamp: point.timestamp,
            tps: point.tps
        })).sort((a, b) => a.timestamp - b.timestamp)
    }

    const chartData = transformDataForChart(tpsData || [])

    if (error) {
        return <div className="text-center py-8 text-red-600">Error loading TPS data</div>
    }

    if (isLoading) {
        return <div className="text-center py-8">Loading TPS data...</div>
    }

    if (!tpsData || tpsData.length === 0) {
        return <div className="text-center py-8 text-gray-500">No TPS data available</div>
    }

    return (
        <div className="h-96">
            <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
                    <XAxis
                        dataKey="time"
                        tick={{ fontSize: 12 }}
                        interval="preserveStartEnd"
                    />
                    <YAxis
                        tick={{ fontSize: 12 }}
                        label={{ value: 'Transactions Per Second', angle: -90, position: 'insideLeft' }}
                        domain={[0, 'dataMax']}
                    />
                    <Tooltip
                        formatter={(value: number) => [
                            `${Number(value).toFixed(2)} TPS`,
                            'TPS'
                        ]}
                        labelFormatter={(label: string) => `Time: ${label}`}
                    />
                    <Legend />
                    <Line
                        type="monotone"
                        dataKey="tps"
                        stroke="#3B82F6"
                        strokeWidth={2}
                        dot={{ r: 4 }}
                        name="TPS"
                    />
                </LineChart>
            </ResponsiveContainer>
        </div>
    )
}

export default function TPSOverTime() {
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
                <h1 className="text-3xl font-bold">📈 TPS Over Time</h1>

                <div className="border border-gray-200 rounded-xl bg-white p-6">
                    <div className="mb-3 text-base">Transactions Per Second (TPS)</div>
                    <p className="text-sm mb-3">
                        Track transaction throughput performance over time:
                    </p>
                    <ul className="space-y-1 mb-3">
                        <li><span className="font-semibold">TPS:</span> Number of transactions processed per second</li>
                        <li><span className="font-semibold">Time Intervals:</span> Data aggregated over time periods</li>
                        <li><span className="font-semibold">Performance:</span> Higher TPS indicates better network throughput</li>
                    </ul>
                </div>

                <ChainSelector
                    chains={chains}
                    selectedChainId={selectedChainId}
                    onChainSelect={setSelectedChainId}
                    defaultChainId={16180}
                />
            </div>

            <div className="grid grid-cols-1">
                <ExampleCard
                    name="TPS Over Time Chart"
                    curlString={`curl -X GET "${window.location.origin}/api/${selectedChainId || '{chainId}'}/stats/tps?count=30"`}
                >
                    <TPSChart selectedChainId={selectedChainId} />
                </ExampleCard>
            </div>
        </div>
    )
}