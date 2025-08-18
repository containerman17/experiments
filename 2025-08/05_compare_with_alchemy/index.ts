import { config } from 'process';
import { createPublicClient, webSocket, http } from 'viem';

//Get RPC URLs from environment variables
const RPC_URLS: string[] = []

for (let key in process.env) {
    if (key.startsWith("RPC_URL_") && process.env[key] !== undefined && process.env[key] !== '') {
        RPC_URLS.push(process.env[key]!)
    }
}

if (RPC_URLS.length === 0) {
    console.error('No RPC URLs found in environment variables')
    process.exit(1)
}

function extractDomain(rpcUrl: string): string {
    const url = new URL(rpcUrl)
    return url.hostname.startsWith("127.0.0.1") ? url.hostname : url.hostname.split('.').slice(-2).join('.')
}

const blockReceivedTimestamps: Record<number, Record<string, number>> = {}

for (let rpcUrl of RPC_URLS) {
    const client = createPublicClient({
        transport: rpcUrl.startsWith('ws') ? webSocket(rpcUrl) : http(rpcUrl)
    })

    client.watchBlockNumber({
        pollingInterval: rpcUrl.startsWith('ws') ? undefined : 200,
        onBlockNumber: async (blockNumberBN: bigint) => {
            const blockNumber = Number(blockNumberBN)
            const domain = extractDomain(rpcUrl)

            if (!blockReceivedTimestamps[blockNumber]) { blockReceivedTimestamps[blockNumber] = {} }

            blockReceivedTimestamps[blockNumber][domain] = Date.now()
            if (Object.keys(blockReceivedTimestamps[blockNumber]).length === RPC_URLS.length) {
                printStatsMessage(blockNumber, blockReceivedTimestamps[blockNumber])
            }
        }
    });
}

const allDomains = RPC_URLS.map(extractDomain)

function printStatsMessage(blockNumber: number, timestamps: Record<string, number>) {
    const fastestTime = Math.min(...Object.values(timestamps))

    let printString = `🏆 Block ${blockNumber} |`

    function getDelayEmoji(delayMs: number): string {
        if (delayMs < 500) return '✅'
        if (delayMs < 1200) return '🐌'
        if (delayMs < 3000) return '⚠️'
        return '💀'
    }

    for (let domain of allDomains) {
        const time = timestamps[domain]
        const diff = time - fastestTime
        const diffInSeconds = (diff / 1000).toFixed(3)
        const emoji = getDelayEmoji(diff)
        printString += ` ${domain} ${emoji} +${diffInSeconds}s |`
    }

    console.log(printString)
}
