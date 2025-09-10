import { useState, useEffect } from "react"
import { getApiChains } from "./client/sdk.gen"
import { type GetApiChainsResponses, type GetApiByEvmChainIdContractStatsResponse } from "./client/types.gen"
import { useQuery } from '@tanstack/react-query'
import ExampleCard from "./components/ExampleCard"
import ErrorComponent from "./components/ErrorComponent"

const DEMO_CHAIN = 43114
const DEMO_CONTRACT = "0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789"

type Chain = GetApiChainsResponses[200][0]
type ContractStatsResponse = GetApiByEvmChainIdContractStatsResponse

export default function ContractStats() {
    const [selectedChain, setSelectedChain] = useState<number | null>(null)
    const [contracts, setContracts] = useState<string>(DEMO_CONTRACT)
    const [tsFrom, setTsFrom] = useState<number>(Math.floor(Date.now() / 1000) - 30 * 86400) // Default: 30 days ago
    const [tsTo, setTsTo] = useState<number>(Math.floor(Date.now() / 1000))

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

    // Set demo chain when chains are loaded
    useEffect(() => {
        if (chains.length > 0 && selectedChain === null) {
            const demoChain = chains.find(chain => chain.evmChainId === DEMO_CHAIN)
            if (demoChain) {
                setSelectedChain(DEMO_CHAIN)
            }
        }
    }, [chains, selectedChain])

    const { data: statsData, error: statsError, isError: isStatsError, isLoading: isStatsLoading, refetch } = useQuery<ContractStatsResponse>({
        queryKey: ['contractStats', selectedChain, contracts, tsFrom, tsTo],
        queryFn: async () => {
            if (!selectedChain || !contracts.trim()) {
                throw new Error('Please select a chain and enter contract addresses')
            }

            const response = await fetch(
                `${window.location.origin}/api/${selectedChain}/contract-stats?` +
                new URLSearchParams({
                    contracts: contracts.trim(),
                    tsFrom: tsFrom.toString(),
                    tsTo: tsTo.toString()
                })
            )

            if (!response.ok) {
                const error = await response.json().catch(() => ({ error: 'Failed to fetch contract stats' }))
                throw new Error(error.error || 'Failed to fetch contract stats')
            }

            return await response.json()
        },
        enabled: !!selectedChain && !!contracts.trim(),
        retry: false
    })

    if (chainsIsError) {
        return <ErrorComponent message={chainsError?.message || 'Failed to load chain data'} />
    }

    const formatTimestampForInput = (ts: number): string => {
        if (ts === 0) return new Date(0).toISOString().slice(0, 16)
        return new Date(ts * 1000).toISOString().slice(0, 16)
    }

    const handleTsFromChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const value = parseInt(event.target.value)
        if (!isNaN(value) && value >= 0) {
            setTsFrom(value)
        }
    }

    const handleTsToChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const value = parseInt(event.target.value)
        if (!isNaN(value) && value >= 0) {
            setTsTo(value)
        }
    }

    const handleFromDateTimeChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const dateTime = new Date(event.target.value)
        setTsFrom(Math.floor(dateTime.getTime() / 1000))
    }

    const handleToDateTimeChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const dateTime = new Date(event.target.value)
        setTsTo(Math.floor(dateTime.getTime() / 1000))
    }

    const handleContractsChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
        setContracts(event.target.value)
    }

    const formatPercentage = (value: number) => {
        return `${value.toFixed(2)}%`
    }

    const formatGasCost = (value: number) => {
        if (value < 0.0001) return value.toExponential(2)
        if (value < 1) return value.toFixed(6)
        if (value < 1000) return value.toFixed(4)
        return value.toLocaleString(undefined, { maximumFractionDigits: 2 })
    }

    return (
        <div className="py-8 px-4 md:px-8">
            <div className="flex flex-col gap-4 mb-8">
                <h1 className="text-3xl font-bold">📊 Contract Statistics</h1>

                <div className="border border-gray-200 rounded-xl bg-white p-6">
                    <div className="mb-3 text-base">Comprehensive Contract Activity Analysis</div>
                    <p className="text-sm mb-3">
                        Get detailed statistics for specified contract addresses on a given chain:
                    </p>
                    <ul className="space-y-1 mb-4">
                        <li><span className="font-semibold">Transactions:</span> Total transaction count and AVAX costs</li>
                        <li><span className="font-semibold">ICM Messages:</span> Inter-chain message count and associated AVAX costs</li>
                        <li><span className="font-semibold">User Activity:</span> Unique addresses and daily averages</li>
                        <li><span className="font-semibold">Concentration:</span> Transaction distribution among top accounts</li>
                    </ul>

                    <div className="space-y-4">
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
                                        {chain.chainName} ({chain.evmChainId})
                                    </option>
                                ))}
                            </select>
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                                Contract Addresses
                                <span className="text-xs text-gray-500 ml-2">(comma-separated)</span>
                            </label>
                            <textarea
                                value={contracts}
                                onChange={handleContractsChange}
                                className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 font-mono text-sm"
                                placeholder="0x1234..., 0x5678..., 0xabcd..."
                                rows={3}
                            />
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">
                                    From Date
                                </label>
                                <input
                                    type="datetime-local"
                                    value={formatTimestampForInput(tsFrom)}
                                    onChange={handleFromDateTimeChange}
                                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                                />
                                <input
                                    type="number"
                                    value={tsFrom}
                                    onChange={handleTsFromChange}
                                    className="w-full mt-2 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                                    placeholder="Unix timestamp"
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">
                                    To Date
                                </label>
                                <input
                                    type="datetime-local"
                                    value={formatTimestampForInput(tsTo)}
                                    onChange={handleToDateTimeChange}
                                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                                />
                                <input
                                    type="number"
                                    value={tsTo}
                                    onChange={handleTsToChange}
                                    className="w-full mt-2 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                                    placeholder="Unix timestamp"
                                />
                            </div>
                        </div>

                        <button
                            onClick={() => refetch()}
                            disabled={!selectedChain || !contracts.trim() || isStatsLoading}
                            className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
                        >
                            {isStatsLoading ? 'Loading...' : 'Get Statistics'}
                        </button>
                    </div>
                </div>
            </div>

            {selectedChain && contracts.trim() && (
                <ExampleCard
                    name="Contract Statistics Results"
                    curlString={`curl -X GET "${window.location.origin}/api/${selectedChain}/contract-stats?contracts=${encodeURIComponent(contracts.trim())}&tsFrom=${tsFrom}&tsTo=${tsTo}"`}
                >
                    {isStatsLoading ? (
                        <div className="text-center py-8">Loading contract statistics...</div>
                    ) : isStatsError ? (
                        <div className="text-center py-8 text-red-500">
                            {statsError?.message || 'Failed to load contract statistics'}
                        </div>
                    ) : statsData ? (
                        <div className="space-y-6">
                            {/* Contract Addresses */}
                            <div className="bg-gray-50 p-4 rounded-lg">
                                <h3 className="text-sm font-semibold text-gray-700 mb-2">Analyzed Contracts</h3>
                                <div className="space-y-1">
                                    {statsData.contracts.map((contract, index) => (
                                        <div key={index} className="font-mono text-sm text-gray-600">
                                            {contract}
                                        </div>
                                    ))}
                                </div>
                            </div>

                            {/* Time Range */}
                            <div className="bg-gray-50 p-4 rounded-lg">
                                <h3 className="text-sm font-semibold text-gray-700 mb-2">Time Range</h3>
                                <div className="text-sm text-gray-600">
                                    {new Date(statsData.timeRange.from * 1000).toLocaleString()} - {new Date(statsData.timeRange.to * 1000).toLocaleString()}
                                </div>
                            </div>

                            {/* Statistics Grid */}
                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                {/* Transactions Card */}
                                <div className="bg-white border border-gray-200 rounded-lg p-4">
                                    <h3 className="text-sm font-semibold text-gray-700 mb-3">Transactions</h3>
                                    <div className="space-y-2">
                                        <div className="flex justify-between">
                                            <span className="text-sm text-gray-600">Total Count</span>
                                            <span className="font-mono font-medium">{statsData.transactions.total.toLocaleString()}</span>
                                        </div>
                                        <div className="flex justify-between">
                                            <span className="text-sm text-gray-600">Total AVAX Cost</span>
                                            <span className="font-mono font-medium">{formatGasCost(statsData.transactions.totalGasCost)}</span>
                                        </div>
                                    </div>
                                </div>

                                {/* ICM Messages Card */}
                                <div className="bg-white border border-gray-200 rounded-lg p-4">
                                    <h3 className="text-sm font-semibold text-gray-700 mb-3">ICM Messages</h3>
                                    <div className="space-y-2">
                                        <div className="flex justify-between">
                                            <span className="text-sm text-gray-600">Message Count</span>
                                            <span className="font-mono font-medium">{statsData.icmMessages.count.toLocaleString()}</span>
                                        </div>
                                        <div className="flex justify-between">
                                            <span className="text-sm text-gray-600">Total AVAX Cost</span>
                                            <span className="font-mono font-medium">{formatGasCost(statsData.icmMessages.totalGasCost)}</span>
                                        </div>
                                    </div>
                                </div>

                                {/* User Activity Card */}
                                <div className="bg-white border border-gray-200 rounded-lg p-4">
                                    <h3 className="text-sm font-semibold text-gray-700 mb-3">User Activity</h3>
                                    <div className="space-y-2">
                                        <div className="flex justify-between">
                                            <span className="text-sm text-gray-600">Unique Addresses</span>
                                            <span className="font-mono font-medium">{statsData.interactions.uniqueAddresses.toLocaleString()}</span>
                                        </div>
                                        <div className="flex justify-between">
                                            <span className="text-sm text-gray-600">Avg Daily Users</span>
                                            <span className="font-mono font-medium">{statsData.interactions.avgDailyAddresses.toLocaleString()}</span>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* Concentration Analysis */}
                            <div className="bg-white border border-gray-200 rounded-lg p-4">
                                <h3 className="text-sm font-semibold text-gray-700 mb-3">Transaction Concentration</h3>
                                <div className="grid grid-cols-2 gap-4">
                                    <div className="text-center p-4 bg-gray-50 rounded-lg">
                                        <div className="text-2xl font-bold text-blue-600">
                                            {formatPercentage(statsData.concentration.top5AccountsPercentage)}
                                        </div>
                                        <div className="text-sm text-gray-600 mt-1">Top 5 Accounts</div>
                                    </div>
                                    <div className="text-center p-4 bg-gray-50 rounded-lg">
                                        <div className="text-2xl font-bold text-indigo-600">
                                            {formatPercentage(statsData.concentration.top20AccountsPercentage)}
                                        </div>
                                        <div className="text-sm text-gray-600 mt-1">Top 20 Accounts</div>
                                    </div>
                                </div>
                                <div className="mt-3 text-xs text-gray-500">
                                    Percentage of total transactions made by the most active accounts
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div className="text-center py-8 text-gray-500">
                            Select a chain and enter contract addresses to view statistics
                        </div>
                    )}
                </ExampleCard>
            )}
        </div>
    )
}
