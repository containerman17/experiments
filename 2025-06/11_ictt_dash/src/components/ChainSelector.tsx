import { useEffect } from "react"
import { type GetApiChainsResponses } from "../client/types.gen"

type Chain = GetApiChainsResponses[200][0]

interface ChainSelectorProps {
    chains: Chain[]
    selectedChainId: number | null
    onChainSelect: (chainId: number) => void
    defaultChainId?: number
}

export default function ChainSelector({ chains, selectedChainId, onChainSelect, defaultChainId }: ChainSelectorProps) {
    useEffect(() => {
        if (chains.length > 0 && selectedChainId === null) {
            if (defaultChainId && chains.some(chain => chain.evmChainId === defaultChainId)) {
                onChainSelect(defaultChainId)
            } else {
                onChainSelect(chains[0].evmChainId)
            }
        }
    }, [chains, selectedChainId, defaultChainId, onChainSelect])

    return (
        <div className="bg-white rounded-lg shadow-sm p-4">
            <select
                value={selectedChainId || ''}
                onChange={(e) => onChainSelect(Number(e.target.value))}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
            >
                {chains.map(chain => (
                    <option key={chain.evmChainId} value={chain.evmChainId}>
                        {chain.chainName} (ID: {chain.evmChainId})
                    </option>
                ))}
            </select>
        </div>
    )
}