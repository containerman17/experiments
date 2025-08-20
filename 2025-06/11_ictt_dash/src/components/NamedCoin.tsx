import coinNames from "./coinNames.json"

interface NamedCoinProps {
    address: string
    extras?: Record<string, string>
    showAddressWithName?: boolean
}

export default function NamedCoin({ address, extras, showAddressWithName = true }: NamedCoinProps) {
    // Check extras first
    const extraName = extras?.[address]
    if (extraName) {
        return (
            <span>
                {extraName}<br />
                {showAddressWithName && <span className="text-xs text-gray-500 font-mono">{address}</span>}
            </span>
        )
    }

    // Then check coinNames
    const name = coinNames[address as keyof typeof coinNames]
    if (name) {
        return (
            <span>
                {name}<br />
                {showAddressWithName && <span className="text-xs text-gray-500 font-mono">{address}</span>}
            </span>
        )
    }
    return <span>{address}</span>
}
