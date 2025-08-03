import { useState } from "react"
import { getApiIcttTransfers } from "./client/sdk.gen"
import { type GetApiIcttTransfersResponses } from "./client/types.gen"
import { useQuery } from '@tanstack/react-query'
import ExampleCard from "./components/ExampleCard"
import ErrorComponent from "./components/ErrorComponent"

type TransferData = GetApiIcttTransfersResponses[200][0]

export default function ICTTTransfers() {
    const [startTs, setStartTs] = useState<number>(0)
    const [endTs, setEndTs] = useState<number>(Math.floor(Date.now() / 1000))

    const { data, error, isError, isLoading } = useQuery<TransferData[]>({
        queryKey: ['icttTransfers', startTs, endTs],
        queryFn: async () => {
            const res = await getApiIcttTransfers({
                query: { startTs, endTs }
            })
            if (res.data) {
                return res.data
            }
            throw new Error('Failed to fetch ICTT transfers data')
        }
    })

    const handleStartTsChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const value = parseInt(event.target.value)
        if (!isNaN(value) && value >= 0) {
            setStartTs(value)
        }
    }

    const handleEndTsChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const value = parseInt(event.target.value)
        if (!isNaN(value) && value >= 0) {
            setEndTs(value)
        }
    }

    const formatTimestampForInput = (ts: number): string => {
        if (ts === 0) return new Date(0).toISOString().slice(0, 16)
        return new Date(ts * 1000).toISOString().slice(0, 16)
    }

    const handleStartDateTimeChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const dateTime = new Date(event.target.value)
        setStartTs(Math.floor(dateTime.getTime() / 1000))
    }

    const handleEndDateTimeChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const dateTime = new Date(event.target.value)
        setEndTs(Math.floor(dateTime.getTime() / 1000))
    }

    if (isError) {
        return <ErrorComponent message={error?.message || 'Failed to load ICTT transfers data'} />
    }

    return (
        <div className="py-8 px-4 md:px-8">
            <div className="flex flex-col gap-4 mb-8">
                <h1 className="text-3xl font-bold">💸 ICTT Token Transfers</h1>

                <div className="border border-gray-200 rounded-xl bg-white p-6">
                    <div className="mb-3 text-base">Inter-Chain Token Transfer (ICTT) Statistics</div>
                    <p className="text-sm mb-3">
                        View token transfer statistics between chains:
                    </p>
                    <ul className="space-y-1 mb-4">
                        <li><span className="font-semibold">Home Chain:</span> Chain where the ICTT contract is deployed</li>
                        <li><span className="font-semibold">Remote Chain:</span> Partner chain in the transfer</li>
                        <li><span className="font-semibold">Direction:</span> → for outbound (home to remote), ← for inbound (remote to home)</li>
                        <li><span className="font-semibold">Coin Address:</span> Token contract address</li>
                        <li><span className="font-semibold">Transfer Count:</span> Number of transfers in the period</li>
                        <li><span className="font-semibold">Total Amount:</span> Sum of all transferred tokens</li>
                    </ul>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">
                                Start Time
                            </label>
                            <input
                                type="datetime-local"
                                value={formatTimestampForInput(startTs)}
                                onChange={handleStartDateTimeChange}
                                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                            />
                            <input
                                type="number"
                                value={startTs}
                                onChange={handleStartTsChange}
                                className="w-full mt-2 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                                placeholder="Unix timestamp"
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">
                                End Time
                            </label>
                            <input
                                type="datetime-local"
                                value={formatTimestampForInput(endTs)}
                                onChange={handleEndDateTimeChange}
                                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                            />
                            <input
                                type="number"
                                value={endTs}
                                onChange={handleEndTsChange}
                                className="w-full mt-2 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                                placeholder="Unix timestamp"
                            />
                        </div>
                    </div>
                </div>
            </div>

            <ExampleCard
                name="ICTT Token Transfer Statistics"
                curlString={`curl -X GET "${window.location.origin}/api/ictt/transfers?startTs=${startTs}&endTs=${endTs}"`}
            >
                {isLoading ? (
                    <div className="text-center py-8">Loading transfer data...</div>
                ) : !data || data.length === 0 ? (
                    <div className="text-center py-8 text-gray-500">No transfers found in the selected time range</div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="min-w-full divide-y divide-gray-200">
                            <thead className="bg-gray-50">
                                <tr>
                                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                        Home
                                    </th>
                                    <th className="px-1 py-2 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">

                                    </th>
                                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                        Remote
                                    </th>
                                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                        Coin Address on Home Chain
                                    </th>
                                    <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                                        Transfer Count
                                    </th>
                                    <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                                        Total Amount
                                    </th>
                                </tr>
                            </thead>
                            <tbody className="bg-white divide-y divide-gray-200">
                                {data.map((transfer, index) => {
                                    const showHomeChainId = transfer.homeChainName === transfer.homeChainBlockchainId;
                                    const showRemoteChainId = transfer.remoteChainName === transfer.remoteChainBlockchainId;
                                    const arrow = transfer.direction === 'out' ? '→' : '←';

                                    const homeDisplay = showHomeChainId ? transfer.homeChainBlockchainId : transfer.homeChainName;
                                    const remoteDisplay = showRemoteChainId ? transfer.remoteChainBlockchainId : transfer.remoteChainName;

                                    return (
                                        <tr key={`${transfer.homeChainBlockchainId}-${transfer.remoteChainBlockchainId}-${transfer.direction}-${transfer.coinAddress}-${index}`} className="hover:bg-gray-50">
                                            <td className="px-3 py-2 text-sm">
                                                <span className={showHomeChainId ? "font-mono text-gray-600" : "font-medium text-gray-900"}>
                                                    {homeDisplay}
                                                </span>
                                            </td>
                                            <td className="px-1 py-2 text-center">
                                                <span className={`font-bold text-lg ${transfer.direction === 'out' ? 'text-red-600' : 'text-green-600'}`}>
                                                    {arrow}
                                                </span>
                                            </td>
                                            <td className="px-3 py-2 text-sm">
                                                <span className={showRemoteChainId ? "font-mono text-gray-600" : "font-medium text-gray-900"}>
                                                    {remoteDisplay}
                                                </span>
                                            </td>
                                            <td className="px-3 py-2 text-sm font-mono text-gray-600">
                                                {transfer.coinAddress}
                                            </td>
                                            <td className="px-3 py-2 whitespace-nowrap text-sm text-right font-medium">
                                                {transfer.transferCount.toLocaleString()}
                                            </td>
                                            <td className="px-3 py-2 whitespace-nowrap text-sm text-right font-medium">
                                                {transfer.transferCoinsTotal.toLocaleString()}
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
