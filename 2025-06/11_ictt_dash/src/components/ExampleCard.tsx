import { type ReactNode, useEffect } from "react";
import { type GetApiChainsResponses } from "../client/types.gen"

type Chain = GetApiChainsResponses[200][0]

interface ExampleCardProps {
    children: ReactNode;
    curlString: string;
    name: string;
    chains?: Chain[];
    selectedChainId?: number | null;
    onChainSelect?: (chainId: number) => void;
    defaultChainId?: number;
}

export default function ExampleCard({ children, curlString, name, chains, selectedChainId, onChainSelect, defaultChainId }: ExampleCardProps) {
    useEffect(() => {
        if (chains && chains.length > 0 && selectedChainId === null && onChainSelect) {
            if (defaultChainId && chains.some(chain => chain.evmChainId === defaultChainId)) {
                onChainSelect(defaultChainId)
            } else {
                onChainSelect(chains[0].evmChainId)
            }
        }
    }, [chains, selectedChainId, defaultChainId, onChainSelect])
    return (
        <div className="border border-gray-200 rounded-xl bg-white overflow-hidden">
            {/* Header */}
            <div className="border-b border-gray-200 px-6 py-4 bg-gray-50">
                <h3 className="text-sm font-semibold">{name}</h3>
            </div>

            {/* Chain Selector */}
            {chains && onChainSelect && (
                <div className="border-b border-gray-200 p-4">
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
            )}

            {/* Content */}
            <div className="p-6">
                {children}
            </div>

            {/* CURL Example */}
            <div className="border-t border-gray-200 px-6 py-4 bg-gray-50">
                <div className="text-xs font-medium uppercase tracking-wide mb-2">Curl Example</div>
                <pre className="text-xs font-mono w-full block overflow-x-auto m-0 p-0 bg-transparent border-0 rounded-none text-gray-800">{curlString}</pre>
            </div>
        </div>
    );
}
