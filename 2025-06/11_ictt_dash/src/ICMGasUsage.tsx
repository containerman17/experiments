import { useState, useEffect } from "react"
import { getApiGlobalIcmGasUsage } from "./client/sdk.gen"
import { type GetApiGlobalIcmGasUsageResponses } from "./client/types.gen"
import { useQuery } from '@tanstack/react-query'
import ExampleCard from "./components/ExampleCard"
import ErrorComponent from "./components/ErrorComponent"
import TimeRangeSelector from "./components/TimeRangeSelector"

type GasUsageData = GetApiGlobalIcmGasUsageResponses[200][0]

export default function ICMGasUsage() {
    const [startTs, setStartTs] = useState<number>(0)
    const [endTs, setEndTs] = useState<number>(Math.floor(Date.now() / 1000))
    const [selectedChain, setSelectedChain] = useState<string>("")

    const { data, error, isError, isLoading } = useQuery<GasUsageData[]>({
        queryKey: ['icmGasUsage', startTs, endTs],
        queryFn: async () => {
            const res = await getApiGlobalIcmGasUsage({
                query: { startTs, endTs }
            })
            if (res.data) {
                return res.data
            }
            throw new Error('Failed to fetch ICM gas usage data')
        }
    })

    if (isError) {
        return <ErrorComponent message={error?.message || 'Failed to load ICM gas usage data'} />
    }

    // Extract unique chains from data
    const uniqueChains = data ? Array.from(new Set(data.map(row => ({
        id: row.chainBlockchainId,
        name: row.chainName
    })).map(chain => JSON.stringify(chain)))).map(str => JSON.parse(str)) : []

    // Filter data based on selected chain
    const filteredData = data?.filter(row => row.chainBlockchainId === selectedChain) || []

    // Set default chain if it exists and no chain is selected yet
    useEffect(() => {
        const defaultChainId = '2q9e4r6Mu3U68nU1fYjgbR6JvwrRx36CohpAX5UQxse55x1Q5'
        if (data && !selectedChain && uniqueChains.length > 0) {
            // Try to set the default chain, or fall back to the first one
            const hasDefaultChain = uniqueChains.some(chain => chain.id === defaultChainId)
            if (hasDefaultChain) {
                setSelectedChain(defaultChainId)
            } else {
                // Sort chains and select the first one
                const sortedChains = uniqueChains.sort((a, b) => {
                    const aDisplay = a.name === a.id ? a.id : a.name
                    const bDisplay = b.name === b.id ? b.id : b.name
                    return aDisplay.localeCompare(bDisplay)
                })
                setSelectedChain(sortedChains[0].id)
            }
        }
    }, [data, selectedChain, uniqueChains])

    // Calculate totals
    const totals = filteredData?.reduce((acc, row) => ({
        sendCount: acc.sendCount + row.sendCount,
        sendGasCost: acc.sendGasCost + row.sendGasCost,
        receiveCount: acc.receiveCount + row.receiveCount,
        receiveGasCost: acc.receiveGasCost + row.receiveGasCost,
        totalCount: acc.totalCount + row.totalCount,
        totalGasCost: acc.totalGasCost + row.totalGasCost
    }), {
        sendCount: 0,
        sendGasCost: 0,
        receiveCount: 0,
        receiveGasCost: 0,
        totalCount: 0,
        totalGasCost: 0
    })

    return (
        <div className="py-8 px-4 md:px-8">
            <div className="flex flex-col gap-4 mb-8">
                <h1 className="text-3xl font-bold">📊 ICM Gas Usage</h1>

                <div className="border border-gray-200 rounded-xl bg-white p-6">
                    <div className="mb-3 text-base">Inter-Chain Messaging Gas Usage</div>
                    <p className="text-sm mb-3">
                        Track gas costs for sending and receiving cross-chain messages between chains.
                    </p>
                    <ul className="space-y-1 mb-4">
                        <li><span className="font-semibold">Source Chain:</span> Select a chain to view its gas usage with all destination chains</li>
                        <li><span className="font-semibold">Send Count/Gas:</span> Outgoing messages from the selected chain (gas paid in source chain's native token)</li>
                        <li><span className="font-semibold">Receive Count/Gas:</span> Incoming messages to the selected chain (gas paid in source chain's native token)</li>
                        <li><span className="font-semibold">Total:</span> Combined send and receive activity on the selected chain</li>
                    </ul>

                    <div className="flex flex-col gap-4 mt-4">
                        <div>
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

                        <TimeRangeSelector
                            startTs={startTs}
                            endTs={endTs}
                            onStartTsChange={setStartTs}
                            onEndTsChange={setEndTs}
                        />
                    </div>
                </div>
            </div>

            <ExampleCard
                name="ICM Gas Usage by Chain"
                curlString={`curl -X GET "${window.location.origin}/api/global/icm-gas-usage?startTs=${startTs}&endTs=${endTs}"`}
            >
                {isLoading ? (
                    <div className="text-center py-8">Loading gas usage data...</div>
                ) : !filteredData || filteredData.length === 0 ? (
                    <div className="text-center py-8 text-gray-500">No gas usage data found for the selected chain in the selected time range</div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="min-w-full divide-y divide-gray-200">
                            <thead className="bg-gray-50">
                                <tr>
                                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                        Destination Chain
                                    </th>
                                    <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                                        Send Count
                                    </th>
                                    <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                                        Send Gas
                                    </th>
                                    <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                                        Receive Count
                                    </th>
                                    <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                                        Receive Gas
                                    </th>
                                    <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                                        Total Count
                                    </th>
                                    <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                                        Total Gas
                                    </th>
                                </tr>
                            </thead>
                            <tbody className="bg-white divide-y divide-gray-200">
                                {filteredData.map((row, index) => {
                                    const showOtherChainId = row.otherChainName === row.otherChainBlockchainId;
                                    const otherChainDisplay = showOtherChainId ? row.otherChainBlockchainId : row.otherChainName;

                                    return (
                                        <tr key={`${row.chainBlockchainId}-${row.otherChainBlockchainId}-${index}`} className="hover:bg-gray-50">
                                            <td className="px-3 py-2 text-sm">
                                                <span className={showOtherChainId ? "font-mono text-gray-600" : "font-medium text-gray-900"}>
                                                    {otherChainDisplay}
                                                </span>
                                            </td>
                                            <td className="px-3 py-2 whitespace-nowrap text-sm text-right">
                                                {row.sendCount.toLocaleString()}
                                            </td>
                                            <td className="px-3 py-2 whitespace-nowrap text-sm text-right font-mono">
                                                {row.sendGasCost.toFixed(4)}
                                            </td>
                                            <td className="px-3 py-2 whitespace-nowrap text-sm text-right">
                                                {row.receiveCount.toLocaleString()}
                                            </td>
                                            <td className="px-3 py-2 whitespace-nowrap text-sm text-right font-mono">
                                                {row.receiveGasCost.toFixed(4)}
                                            </td>
                                            <td className="px-3 py-2 whitespace-nowrap text-sm text-right font-medium">
                                                {row.totalCount.toLocaleString()}
                                            </td>
                                            <td className="px-3 py-2 whitespace-nowrap text-sm text-right font-medium font-mono">
                                                {row.totalGasCost.toFixed(4)}
                                            </td>
                                        </tr>
                                    )
                                })}
                            </tbody>
                            {totals && (
                                <tfoot className="bg-gray-100 border-t-2 border-gray-300">
                                    <tr>
                                        <td className="px-3 py-2 text-sm font-semibold">
                                            Total
                                        </td>
                                        <td className="px-3 py-2 whitespace-nowrap text-sm text-right font-semibold">
                                            {totals.sendCount.toLocaleString()}
                                        </td>
                                        <td className="px-3 py-2 whitespace-nowrap text-sm text-right font-semibold font-mono">
                                            {totals.sendGasCost.toFixed(4)}
                                        </td>
                                        <td className="px-3 py-2 whitespace-nowrap text-sm text-right font-semibold">
                                            {totals.receiveCount.toLocaleString()}
                                        </td>
                                        <td className="px-3 py-2 whitespace-nowrap text-sm text-right font-semibold font-mono">
                                            {totals.receiveGasCost.toFixed(4)}
                                        </td>
                                        <td className="px-3 py-2 whitespace-nowrap text-sm text-right font-semibold">
                                            {totals.totalCount.toLocaleString()}
                                        </td>
                                        <td className="px-3 py-2 whitespace-nowrap text-sm text-right font-semibold font-mono">
                                            {totals.totalGasCost.toFixed(4)}
                                        </td>
                                    </tr>
                                </tfoot>
                            )}
                        </table>
                    </div>
                )}
            </ExampleCard>
        </div>
    )
}
