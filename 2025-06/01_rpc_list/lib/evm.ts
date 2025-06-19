import fetch from "node-fetch";
import pThrottle from "p-throttle";

const throttle = pThrottle({
    limit: 20,
    interval: 1000
});

let requestsLeft = 0
setInterval(() => {
    if (requestsLeft > 0) {
        console.log(`EVM requests left: ${requestsLeft}`)
    }
}, 1000)

export async function throttledFetch(rpcUrl: string, method: string, params: any[]) {
    try {
        requestsLeft += 1
        return await throttle(fetch)(rpcUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ jsonrpc: "2.0", method: method, params: params, id: 1 })
        })
    } finally {
        requestsLeft -= 1
    }
}

export async function fetchEVMChainId(rpcUrl: string) {
    const response = await throttledFetch(rpcUrl, "eth_chainId", [])
    const data = await response.json() as { result: string }
    return parseInt(data.result, 16)
}

export async function fetchLastBlockNumber(rpcUrl: string) {
    const response = await throttledFetch(rpcUrl, "eth_blockNumber", [])
    const data = await response.json() as { result: string }
    return parseInt(data.result, 16)
}

export async function fetchBlockByNumber(rpcUrl: string, blockNumber: string) {
    const response = await throttledFetch(rpcUrl, "eth_getBlockByNumber", [blockNumber, false])
    const data = await response.json() as { result: any }
    return data.result
}
