import { useEffect, useState } from "react"
import { getApiChains } from "./client/sdk.gen"
import { useQuery } from '@tanstack/react-query'

interface ChainData {
    evmChainId: number;
    chainName: string;
    blockchainId: string;
    hasDebug: boolean;
    lastStoredBlockNumber: number;
    latestRemoteBlockNumber: number;
    txCount: number;
    projectedTxCount: number;
    syncProgress?: string;
}

export default function Sync() {
    const [lastUpdated, setLastUpdated] = useState(new Date())

    const { data: rawChains = [] } = useQuery<ChainData[]>({
        queryKey: ['chains'],
        queryFn: async () => {
            const res = await getApiChains()
            if (res.data) {
                return res.data.map(chain => ({
                    ...chain,
                    syncProgress: chain.latestRemoteBlockNumber > 0
                        ? ((chain.lastStoredBlockNumber / chain.latestRemoteBlockNumber) * 100).toFixed(2)
                        : '0.00'
                })).sort((a, b) => b.projectedTxCount - a.projectedTxCount)
            }
            throw new Error('Failed to fetch chains')
        }
    })

    useEffect(() => {
        if (rawChains.length > 0) {
            setLastUpdated(new Date())
        }
    }, [rawChains])

    return (
        <div className="py-8">
            <div className="flex justify-between items-center mb-8">
                <h1 className="text-3xl font-bold text-gray-800">FrostByte Chain Status</h1>
            </div>

            <div className="bg-white shadow-lg rounded-lg overflow-hidden">
                <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                        <tr>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Chain ID</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Chain Name</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Blockchain ID</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Debug</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Stored Blocks</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Remote Blocks</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Sync Progress</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">TX Count</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Projected TX</th>
                        </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                        {rawChains.map(chain => (
                            <tr key={chain.evmChainId} className="hover:bg-gray-50">
                                <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{chain.evmChainId}</td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{chain.chainName}</td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 font-mono">{chain.blockchainId}</td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                                    {chain.hasDebug
                                        ? <span className="text-green-600">✓</span>
                                        : <span className="text-gray-400">✗</span>}
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{chain.lastStoredBlockNumber.toLocaleString()}</td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{chain.latestRemoteBlockNumber.toLocaleString()}</td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm">
                                    <div className="flex items-center">
                                        <div className="w-24 bg-gray-200 rounded-full h-2 mr-2">
                                            <div className="bg-blue-600 h-2 rounded-full" style={{ width: `${chain.syncProgress}%` }}></div>
                                        </div>
                                        <span className="text-gray-700">{chain.syncProgress}%</span>
                                    </div>
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{chain.txCount.toLocaleString()}</td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{chain.projectedTxCount.toLocaleString()}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            <div className="mt-4 text-sm text-gray-500 text-center">
                Last updated: {lastUpdated.toLocaleString()}
            </div>
        </div>
    )
}
