import { useEffect } from "react"
import { useState } from "react"

declare global {
    interface Window {
        ethereum: any
    }
}

function App() {
    const [localError, setLocalError] = useState<string | null>(null)
    const [isConnected, setIsConnected] = useState<boolean>(false)

    async function connect() {
        try {
            await window.ethereum.request({
                method: "eth_requestAccounts",
            })
            setIsConnected(true)
        } catch (error) {
            setLocalError((error as Error)?.message || "Unknown error")
        }
    }

    async function requestSnaps() {
        try {
            await window.ethereum.request({
                method: "wallet_requestSnaps",
                params: {
                    "local:http://localhost:8080": {},
                },
            })
        } catch (error) {
            setLocalError((error as Error)?.message || "Unknown error")
        }
    }

    if (!window.ethereum) return <div>No Ethereum provider found</div>

    if (localError) return <div className="text-red-500">{localError}</div>

    if (!isConnected) return <button onClick={connect}>Connect</button>

    async function callHelloSnap() {
        window.ethereum.request({
            method: "wallet_snap",
            params: {
                snapId: "local:http://localhost:8080",
                request: {
                    method: "hello",
                },
            },
        }).then((response: any) => {
            console.log(response)
        }).catch((error: Error) => {
            setLocalError(error?.message || "Unknown error")
        })
    }

    return (
        <>
            <button onClick={requestSnaps}>Request Snaps</button>
            <button onClick={callHelloSnap}>Call Hello Snap</button>
        </>
    )
}

export default App
