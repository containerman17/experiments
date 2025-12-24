import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { type PoolPriceData, getPriceKey } from './types'

interface PriceContextValue {
    prices: Record<string, PoolPriceData>
}

const PriceContext = createContext<PriceContextValue | null>(null)

export function usePriceData(): PriceContextValue {
    const ctx = useContext(PriceContext)
    if (!ctx) throw new Error('usePriceData must be used within PriceDataProvider')
    return ctx
}

export function PriceDataProvider({ children }: { children: ReactNode }) {
    const [prices, setPrices] = useState<Record<string, PoolPriceData>>({})

    useEffect(() => {
        const ws = new WebSocket(`ws://${window.location.host}`)

        ws.onmessage = (event) => {
            const { type, data } = JSON.parse(event.data)
            if (type === 'patch') {
                setPrices(prev => {
                    const next = { ...prev }
                    for (const item of data) {
                        next[getPriceKey(item)] = item
                    }
                    return next
                })
            }
        }

        ws.onclose = () => {
            console.log('WebSocket closed, will not auto-reconnect in dev')
        }

        return () => ws.close()
    }, [])

    return (
        <PriceContext.Provider value={{ prices }}>
            {children}
        </PriceContext.Provider>
    )
}
