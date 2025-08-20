import { useState } from "react"
import { getApiGlobalIcttTvl } from "./client/sdk.gen"
import { type GetApiGlobalIcttTvlResponses } from "./client/types.gen"
import { useQuery } from '@tanstack/react-query'
import ErrorComponent from "./components/ErrorComponent"
import NamedCoin from "./components/NamedCoin"

type TVLData = GetApiGlobalIcttTvlResponses[200][0]

interface TokenGroup {
    coinAddress: string
    homeChainName: string
    homeChainBlockchainId: string
    homes: {
        contractAddress: string
        remoteChainName: string
        remoteChainBlockchainId: string
        tvl: number
        inboundTxCount: number
        outboundTxCount: number
        totalTxCount: number
    }[]
    totalTvl: number
    totalInboundTxCount: number
    totalOutboundTxCount: number
    totalTxCount: number
}

export default function ICTTByToken() {
    const [tvlTimestamp, setTvlTimestamp] = useState<number>(Math.floor(Date.now() / 1000))

    const { data: tvlData, error: tvlError, isError: isTvlError, isLoading: isTvlLoading } = useQuery<TVLData[]>({
        queryKey: ['icttTvl', tvlTimestamp],
        queryFn: async () => {
            const res = await getApiGlobalIcttTvl({
                query: { timestamp: tvlTimestamp }
            })
            if (res.data) {
                return res.data
            }
            throw new Error('Failed to fetch ICTT TVL data')
        }
    })

    const formatTimestampForInput = (ts: number): string => {
        if (ts === 0) return new Date(0).toISOString().slice(0, 16)
        return new Date(ts * 1000).toISOString().slice(0, 16)
    }

    const handleTvlTimestampChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const value = parseInt(event.target.value)
        if (!isNaN(value) && value >= 0) {
            setTvlTimestamp(value)
        }
    }

    const handleTvlDateTimeChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const dateTime = new Date(event.target.value)
        setTvlTimestamp(Math.floor(dateTime.getTime() / 1000))
    }

    // Group data by token (coinAddress + homeChain)
    const groupedData: TokenGroup[] = []
    if (tvlData) {
        const tokenMap = new Map<string, TokenGroup>()

        tvlData.forEach(item => {
            // Create unique key for token on home chain
            const tokenKey = `${item.coinAddress}-${item.homeChainBlockchainId}`

            if (!tokenMap.has(tokenKey)) {
                tokenMap.set(tokenKey, {
                    coinAddress: item.coinAddress,
                    homeChainName: item.homeChainName,
                    homeChainBlockchainId: item.homeChainBlockchainId,
                    homes: [],
                    totalTvl: 0,
                    totalInboundTxCount: 0,
                    totalOutboundTxCount: 0,
                    totalTxCount: 0
                })
            }

            const group = tokenMap.get(tokenKey)!
            group.homes.push({
                contractAddress: item.contractAddress,
                remoteChainName: item.remoteChainName,
                remoteChainBlockchainId: item.remoteChainBlockchainId,
                tvl: item.tvl,
                inboundTxCount: item.inboundTxCount,
                outboundTxCount: item.outboundTxCount,
                totalTxCount: item.totalTxCount
            })
            group.totalTvl += item.tvl
            group.totalInboundTxCount += item.inboundTxCount
            group.totalOutboundTxCount += item.outboundTxCount
            group.totalTxCount += item.totalTxCount
        })

        // Convert map to array and sort by total transaction count
        groupedData.push(...Array.from(tokenMap.values()))
        groupedData.sort((a, b) => b.totalTxCount - a.totalTxCount)
    }

    if (isTvlError) {
        return <ErrorComponent message={tvlError?.message || 'Failed to load ICTT TVL data'} />
    }

    return (
        <div className="py-8 px-4 md:px-8">
            <div className="flex flex-col gap-4 mb-8">
                <h1 className="text-3xl font-bold">🪙 ICTT by Token</h1>

                <div className="border border-gray-200 rounded-xl bg-white p-6">
                    <div className="mb-3 text-base">Token-Centric View of ICTT Bridges</div>
                    <p className="text-sm mb-3">
                        View all ICTT bridge instances grouped by token, showing total value locked across all bridges for each token, sorted by total transfer count.
                    </p>
                    <ul className="space-y-1 mb-4">
                        <li><span className="font-semibold">Token Grouping:</span> All bridges for the same token on the same home chain</li>
                        <li><span className="font-semibold">Bridge Homes:</span> Each ICTT contract managing the token</li>
                        <li><span className="font-semibold">Total TVL:</span> Sum of TVL across all bridge instances for the token</li>
                        <li><span className="font-semibold">Sorting:</span> Cards are sorted by total number of transfers (highest first)</li>
                    </ul>

                    <div className="max-w-md">
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                            TVL as of
                        </label>
                        <input
                            type="datetime-local"
                            value={formatTimestampForInput(tvlTimestamp)}
                            onChange={handleTvlDateTimeChange}
                            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                        <input
                            type="number"
                            value={tvlTimestamp}
                            onChange={handleTvlTimestampChange}
                            className="w-full mt-2 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                            placeholder="Unix timestamp"
                        />
                    </div>
                </div>
            </div>

            {isTvlLoading ? (
                <div className="text-center py-8">Loading TVL data...</div>
            ) : !groupedData || groupedData.length === 0 ? (
                <div className="text-center py-8 text-gray-500">No TVL data found</div>
            ) : (
                <div className="grid gap-6">
                    {groupedData.map((group) => {
                        const showHomeChainId = group.homeChainName === group.homeChainBlockchainId
                        const homeDisplay = showHomeChainId ? group.homeChainBlockchainId : group.homeChainName

                        return (
                            <div key={`${group.coinAddress}-${group.homeChainBlockchainId}`} className="border border-gray-200 rounded-xl bg-white p-6">
                                <div className="mb-4">
                                    <div className="flex items-center gap-2 mb-1">
                                        <NamedCoin
                                            address={group.coinAddress}
                                            extras={{
                                                "0x0000000000000000000000000000000000000000": `${group.homeChainName} Native Token`
                                            }}
                                            showAddressWithName={false}
                                        />
                                        <span className="text-sm text-gray-500">on</span>
                                        <span className={showHomeChainId ? "font-mono text-gray-600" : "font-medium text-gray-900"}>
                                            {homeDisplay}
                                        </span>
                                    </div>
                                    <div className="text-xs font-mono text-gray-500">{group.coinAddress}</div>
                                </div>

                                <div className="mb-4">
                                    <div className="text-sm font-medium text-gray-700 mb-2">Bridge Homes:</div>
                                    <div className="overflow-x-auto">
                                        <table className="min-w-full divide-y divide-gray-200">
                                            <thead className="bg-gray-50">
                                                <tr>
                                                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                                        Contract Address
                                                    </th>
                                                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                                        Remote Chain
                                                    </th>
                                                    <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                                                        TVL
                                                    </th>
                                                    <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                                                        Transfers
                                                    </th>
                                                </tr>
                                            </thead>
                                            <tbody className="bg-white divide-y divide-gray-200">
                                                {group.homes.map((home) => {
                                                    const showRemoteChainId = home.remoteChainName === home.remoteChainBlockchainId
                                                    const remoteDisplay = showRemoteChainId ? home.remoteChainBlockchainId : home.remoteChainName

                                                    return (
                                                        <tr key={`${home.contractAddress}-${home.remoteChainBlockchainId}`} className="hover:bg-gray-50">
                                                            <td className="px-3 py-2 text-sm font-mono text-gray-600">
                                                                {home.contractAddress}
                                                            </td>
                                                            <td className="px-3 py-2 text-sm">
                                                                <span className={showRemoteChainId ? "font-mono text-gray-600" : "font-medium text-gray-900"}>
                                                                    {remoteDisplay}
                                                                </span>
                                                            </td>
                                                            <td className="px-3 py-2 whitespace-nowrap text-sm text-right font-medium">
                                                                {home.tvl.toLocaleString()}
                                                            </td>
                                                            <td className="px-3 py-2 whitespace-nowrap text-sm text-right">
                                                                {home.totalTxCount.toLocaleString()}
                                                            </td>
                                                        </tr>
                                                    )
                                                })}
                                            </tbody>
                                        </table>
                                    </div>
                                </div>

                                <div className="border-t pt-3 flex justify-between items-center">
                                    <div className={`text-lg font-bold`}>
                                        Total TVL: {group.totalTvl.toLocaleString()}
                                    </div>
                                    <div className="text-lg">
                                        Total Transfers: <span className="font-bold">{group.totalTxCount.toLocaleString()}</span>
                                    </div>
                                </div>
                            </div>
                        )
                    })}
                </div>
            )}
        </div>
    )
}
