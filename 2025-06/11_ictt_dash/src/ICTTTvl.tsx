import { useState } from "react"
import { getApiGlobalIcttTvl } from "./client/sdk.gen"
import { type GetApiGlobalIcttTvlResponses } from "./client/types.gen"
import { useQuery } from '@tanstack/react-query'
import ExampleCard from "./components/ExampleCard"
import ErrorComponent from "./components/ErrorComponent"
import NamedCoin from "./components/NamedCoin"

type TVLData = GetApiGlobalIcttTvlResponses[200][0]

export default function ICTTTvl() {
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

    if (isTvlError) {
        return <ErrorComponent message={tvlError?.message || 'Failed to load ICTT TVL data'} />
    }

    return (
        <div className="py-8 px-4 md:px-8">
            <div className="flex flex-col gap-4 mb-8">
                <h1 className="text-3xl font-bold">💰 ICTT Total Value Locked</h1>

                <div className="border border-gray-200 rounded-xl bg-white p-6">
                    <div className="mb-3 text-base">Total Value Locked (TVL) Overview</div>
                    <p className="text-sm mb-3">
                        TVL represents the net token balance locked in Inter-Chain Token Transfer (ICTT) contracts across different chain pairs.
                    </p>
                    <ul className="space-y-1 mb-4">
                        <li><span className="font-semibold">Calculation:</span> Total outbound transfers minus total inbound transfers</li>
                        <li><span className="font-semibold">Positive TVL:</span> Net outflow from the home chain (tokens locked on remote chain)</li>
                        <li><span className="font-semibold">Negative TVL:</span> Net inflow to the home chain (more tokens returned than sent)</li>
                        <li><span className="font-semibold">Zero TVL:</span> Balanced flows - equal amounts transferred in both directions</li>
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

            <ExampleCard
                name="ICTT Total Value Locked (TVL)"
                curlString={`curl -X GET "${window.location.origin}/api/global/ictt/tvl?timestamp=${tvlTimestamp}"`}
            >
                {isTvlLoading ? (
                    <div className="text-center py-8">Loading TVL data...</div>
                ) : !tvlData || tvlData.length === 0 ? (
                    <div className="text-center py-8 text-gray-500">No TVL data found</div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="min-w-full divide-y divide-gray-200">
                            <thead className="bg-gray-50">
                                <tr>
                                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                        Home Chain
                                    </th>
                                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                        Remote Chain
                                    </th>
                                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                        ICTT Home Contract
                                    </th>
                                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                        Coin Address
                                    </th>
                                    <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                                        TVL
                                    </th>
                                </tr>
                            </thead>
                            <tbody className="bg-white divide-y divide-gray-200">
                                {tvlData.map((item, index) => {
                                    const showHomeChainId = item.homeChainName === item.homeChainBlockchainId;
                                    const showRemoteChainId = item.remoteChainName === item.remoteChainBlockchainId;
                                    const homeDisplay = showHomeChainId ? item.homeChainBlockchainId : item.homeChainName;
                                    const remoteDisplay = showRemoteChainId ? item.remoteChainBlockchainId : item.remoteChainName;
                                    const tvlClass = item.tvl > 0 ? 'text-red-600' : item.tvl < 0 ? 'text-green-600' : 'text-gray-900';

                                    return (
                                        <tr key={`${item.homeChainBlockchainId}-${item.remoteChainBlockchainId}-${item.contractAddress}-${item.coinAddress}-${index}`} className="hover:bg-gray-50">
                                            <td className="px-3 py-2 text-sm">
                                                <span className={showHomeChainId ? "font-mono text-gray-600" : "font-medium text-gray-900"}>
                                                    {homeDisplay}
                                                </span>
                                            </td>
                                            <td className="px-3 py-2 text-sm">
                                                <span className={showRemoteChainId ? "font-mono text-gray-600" : "font-medium text-gray-900"}>
                                                    {remoteDisplay}
                                                </span>
                                            </td>
                                            <td className="px-3 py-2 text-sm font-mono text-gray-600">
                                                {item.contractAddress}
                                            </td>
                                            <td className="px-3 py-2 text-sm font-mono text-gray-600">
                                                <NamedCoin
                                                    address={item.coinAddress}
                                                    extras={{
                                                        "0x0000000000000000000000000000000000000000": `${item.homeChainName} Native Token`
                                                    }}
                                                />
                                            </td>
                                            <td className={`px-3 py-2 whitespace-nowrap text-sm text-right font-medium ${tvlClass}`}>
                                                {item.tvl.toLocaleString()}
                                            </td>
                                        </tr>
                                    )
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </ExampleCard>
        </div>
    )
}
