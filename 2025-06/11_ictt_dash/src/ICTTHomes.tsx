import { useMemo, useState } from "react"
import { getApiIcttContractHomes, getApiChains } from "./client/sdk.gen"
import { type GetApiIcttContractHomesResponses, type GetApiChainsResponses } from "./client/types.gen"
import { useQuery } from '@tanstack/react-query'

type IcttContractHome = GetApiIcttContractHomesResponses[200][0]
type Chain = GetApiChainsResponses[200][0]

function formatAmount(amount: string, decimals: number): string {
    try {
        const value = BigInt(amount)
        if (value === 0n) return "0.0000"

        // Convert to decimal representation
        const divisor = BigInt(10 ** decimals)
        const wholePart = value / divisor
        const fractionalPart = value % divisor

        // Format whole part with commas
        const wholeStr = wholePart.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')

        // Get the full fractional part and pad to 4 decimal places
        const fractionalStr = fractionalPart.toString().padStart(decimals, '0')
        const fourDecimalFractional = fractionalStr.slice(0, 4).padEnd(4, '0')

        return `${wholeStr}.${fourDecimalFractional}`
    } catch {
        return "Invalid bignumber"
    }
}

export default function ICTTHomes() {
    const { data: homes = [] } = useQuery<IcttContractHome[]>({
        queryKey: ['icttHomes'],
        queryFn: async () => {
            const res = await getApiIcttContractHomes()
            if (res.data) {
                return res.data
            }
            throw new Error('Failed to fetch ICTT homes')
        }
    })

    const { data: chains = [] } = useQuery<Chain[]>({
        queryKey: ['chains'],
        queryFn: async () => {
            const res = await getApiChains()
            if (res.data) {
                return res.data
            }
            throw new Error('Failed to fetch chains')
        }
    })

    const chainMap = useMemo(() => {
        return chains.reduce((map, chain) => {
            map.set(chain.blockchainId, { chainName: chain.chainName, evmChainId: chain.evmChainId })
            return map
        }, new Map<string, { chainName: string; evmChainId: number }>())
    }, [chains])

    // Group homes by chain
    const homesByChain = useMemo(() => {
        const grouped = new Map<string, { chainName: string; evmChainId: number; homes: IcttContractHome[] }>()
        homes.forEach(home => {
            const key = `${home.evmChainId}` // Use only chain ID as key
            if (!grouped.has(key)) {
                grouped.set(key, {
                    chainName: home.chainName,
                    evmChainId: home.evmChainId,
                    homes: []
                })
            }
            grouped.get(key)!.homes.push(home)
        })
        return Array.from(grouped.entries())
            .sort(([, a], [, b]) => a.chainName.localeCompare(b.chainName))
    }, [homes])

    // Track which chains are expanded
    const [expandedChains, setExpandedChains] = useState<Set<string>>(new Set())

    const toggleChain = (chainKey: string) => {
        setExpandedChains(prev => {
            const newSet = new Set(prev)
            if (newSet.has(chainKey)) {
                newSet.delete(chainKey)
            } else {
                newSet.add(chainKey)
            }
            return newSet
        })
    }

    return (
        <div className="py-8">
            <div className="mb-12">
                <h1 className="text-3xl font-bold text-gray-800">🌐 ICTT Contract Homes</h1>
                <p className="text-gray-600 mt-2">Inter-Chain Token Transfer contracts across multiple chains</p>
            </div>

            {homesByChain.map(([chainIdKey, { chainName, evmChainId, homes: chainHomes }]) => {
                const isExpanded = expandedChains.has(chainIdKey)

                return (
                    <div key={chainIdKey} className="mb-6">
                        <button
                            onClick={() => toggleChain(chainIdKey)}
                            className="w-full bg-gray-100 hover:bg-gray-200 rounded-lg p-4 flex items-center justify-between transition-colors"
                        >
                            <div className="flex items-center gap-3">
                                <span className="text-xl">{isExpanded ? '▼' : '▶'}</span>
                                <h2 className="text-xl font-bold text-gray-800">
                                    ⛓️ {chainName} <span className="text-gray-500 text-lg font-normal">(Chain ID: {evmChainId})</span>
                                </h2>
                            </div>
                            <div className="text-gray-600 font-medium">
                                {chainHomes.length} home{chainHomes.length !== 1 ? 's' : ''}
                            </div>
                        </button>

                        {isExpanded && (
                            <div className="mt-4 space-y-6">
                                {chainHomes.map((home, index) => (
                                    <div key={index} className="bg-white shadow-lg rounded-lg p-6">
                                        <div className="mb-6">
                                            <div className="flex items-center justify-between mb-4">
                                                <div>
                                                    <h3 className="text-lg font-semibold text-gray-800">Contract Home</h3>
                                                    <p className="text-sm text-gray-600 font-mono">{home.address}</p>
                                                    <p className="text-xs text-gray-500">Blockchain ID: {home.blockchainId}</p>
                                                </div>
                                                <div className="text-right space-y-2">
                                                    <div className="text-sm">
                                                        <span className="text-gray-600">Successful Calls:</span>
                                                        <span className="text-green-600 ml-2">✅ {home.callSucceededCnt}</span>
                                                        <span className="text-xs text-gray-500 ml-1">({formatAmount(home.callSucceededSum, 18)})</span>
                                                    </div>
                                                    <div className="text-sm">
                                                        <span className="text-gray-600">Failed Calls:</span>
                                                        <span className="text-red-600 ml-2">❌ {home.callFailedCnt}</span>
                                                        <span className="text-xs text-gray-500 ml-1">({formatAmount(home.callFailedSum, 18)})</span>
                                                    </div>
                                                    <div className="text-sm">
                                                        <span className="text-gray-600">Withdrawals:</span>
                                                        <span className="text-blue-600 ml-2">💸 {home.tokensWithdrawnCnt}</span>
                                                        <span className="text-xs text-gray-500 ml-1">({formatAmount(home.tokensWithdrawnSum, 18)})</span>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>

                                        {home.remotes.length > 0 ? (
                                            <div>
                                                <h4 className="text-md font-semibold text-gray-700 mb-3">📡 Remote Destinations</h4>
                                                <div className="overflow-x-auto">
                                                    <table className="min-w-full divide-y divide-gray-200">
                                                        <thead className="bg-gray-50">
                                                            <tr>
                                                                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 tracking-wider">
                                                                    Destination
                                                                </th>
                                                                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 tracking-wider">
                                                                    Remote Address
                                                                </th>
                                                                <th className="px-4 py-2 text-center text-xs font-medium text-gray-500 tracking-wider">
                                                                    CollateralAdded
                                                                </th>
                                                                <th className="px-4 py-2 text-center text-xs font-medium text-gray-500 tracking-wider">
                                                                    TokensSent
                                                                </th>
                                                                <th className="px-4 py-2 text-center text-xs font-medium text-gray-500 tracking-wider">
                                                                    TokensRouted
                                                                </th>
                                                                <th className="px-4 py-2 text-center text-xs font-medium text-gray-500 tracking-wider">
                                                                    TokensAndCallSent
                                                                </th>
                                                                <th className="px-4 py-2 text-center text-xs font-medium text-gray-500 tracking-wider">
                                                                    TokensAndCallRouted
                                                                </th>
                                                            </tr>
                                                        </thead>
                                                        <tbody className="bg-white divide-y divide-gray-200">
                                                            {home.remotes.map((remote, rIndex) => {
                                                                const remoteChain = chainMap.get(remote.remoteBlockchainID)
                                                                return (
                                                                    <tr key={rIndex} className="hover:bg-gray-50">
                                                                        <td className="px-4 py-3 text-sm">
                                                                            {remoteChain ? (
                                                                                <div>
                                                                                    <div className="font-medium text-gray-900">
                                                                                        {remoteChain.chainName}
                                                                                    </div>
                                                                                    <div className="text-xs text-gray-500">
                                                                                        ID: {remoteChain.evmChainId}
                                                                                    </div>
                                                                                </div>
                                                                            ) : (
                                                                                <div className="font-medium text-gray-900">
                                                                                    {remote.remoteBlockchainID}
                                                                                </div>
                                                                            )}
                                                                        </td>
                                                                        <td className="px-4 py-3 text-sm">
                                                                            <div className="font-mono text-xs text-gray-600">
                                                                                {remote.remoteTokenTransferrerAddress}
                                                                            </div>
                                                                            <div className="text-xs text-gray-500 mt-1">
                                                                                {remote.initialCollateralNeeded ? '🔒 Collateral Required' : '✅ No Collateral'}
                                                                                {' • '}{remote.tokenDecimals} decimals
                                                                            </div>
                                                                        </td>
                                                                        <td className="px-4 py-3 text-sm text-center">
                                                                            <div className="text-gray-900">{remote.collateralAddedCnt}</div>
                                                                            <div className="text-xs text-gray-500">
                                                                                {formatAmount(remote.collateralAddedSum, remote.tokenDecimals)}
                                                                            </div>
                                                                        </td>
                                                                        <td className="px-4 py-3 text-sm text-center">
                                                                            <div className="text-gray-900">{remote.tokensSentCnt}</div>
                                                                            <div className="text-xs text-gray-500">
                                                                                {formatAmount(remote.tokensSentSum, remote.tokenDecimals)}
                                                                            </div>
                                                                        </td>
                                                                        <td className="px-4 py-3 text-sm text-center">
                                                                            <div className="text-gray-900">{remote.tokensRoutedCnt}</div>
                                                                            <div className="text-xs text-gray-500">
                                                                                {formatAmount(remote.tokensRoutedSum, remote.tokenDecimals)}
                                                                            </div>
                                                                        </td>
                                                                        <td className="px-4 py-3 text-sm text-center">
                                                                            <div className="text-gray-900">{remote.tokensAndCallSentCnt}</div>
                                                                            <div className="text-xs text-gray-500">
                                                                                {formatAmount(remote.tokensAndCallSentSum, remote.tokenDecimals)}
                                                                            </div>
                                                                        </td>
                                                                        <td className="px-4 py-3 text-sm text-center">
                                                                            <div className="text-gray-900">{remote.tokensAndCallRoutedCnt}</div>
                                                                            <div className="text-xs text-gray-500">
                                                                                {formatAmount(remote.tokensAndCallRoutedSum, remote.tokenDecimals)}
                                                                            </div>
                                                                        </td>
                                                                    </tr>
                                                                )
                                                            })}
                                                        </tbody>
                                                    </table>
                                                </div>
                                            </div>
                                        ) : (
                                            <p className="text-gray-500 text-sm">No remote destinations configured</p>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )
            })}

            {homes.length === 0 && (
                <div className="text-center py-12">
                    <p className="text-gray-500">No ICTT contract homes found</p>
                </div>
            )}
        </div>
    )
}   
