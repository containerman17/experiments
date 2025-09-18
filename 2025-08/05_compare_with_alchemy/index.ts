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

const blockData: Record<number, { timestamp: number; receivedTimestamps: Record<string, number> }> = {}

for (let rpcUrl of RPC_URLS) {
    const client = createPublicClient({
        transport: rpcUrl.startsWith('ws') ? webSocket(rpcUrl) : http(rpcUrl)
    })

    client.watchBlockNumber({
        pollingInterval: rpcUrl.startsWith('ws') ? undefined : 200,
        onBlockNumber: async (blockNumberBN: bigint) => {
            const blockNumber = Number(blockNumberBN)
            const domain = extractDomain(rpcUrl)

            try {
                const block = await client.getBlock({
                    blockNumber: blockNumberBN,
                    includeTransactions: false
                })

                if (Number(block.number) !== blockNumber) {
                    console.warn(`${domain} reported block ${blockNumber} but returned wrong block`)
                    return
                }

                if (!blockData[blockNumber]) {
                    blockData[blockNumber] = {
                        timestamp: Number(block.timestamp) * 1000, // Convert to milliseconds
                        receivedTimestamps: {}
                    }
                }

                blockData[blockNumber].receivedTimestamps[domain] = Date.now()

                if (Object.keys(blockData[blockNumber].receivedTimestamps).length === RPC_URLS.length) {
                    printStatsMessage(blockNumber, blockData[blockNumber])
                }
            } catch (error) {
                console.warn(`${domain} failed to get block ${blockNumber}: ${error}`)
            }
        }
    });
}

const allDomains = RPC_URLS.map(extractDomain)

function printStatsMessage(blockNumber: number, blockInfo: { timestamp: number; receivedTimestamps: Record<string, number> }) {
    let printString = `⛏️ Block ${blockNumber} |`

    function getDelayEmoji(delayMs: number): string {
        if (delayMs < 1000) return '✅'
        if (delayMs < 3000) return '🐌'
        if (delayMs < 5000) return '⚠️'
        return '💀'
    }

    for (let domain of allDomains) {
        const receivedTime = blockInfo.receivedTimestamps[domain]
        if (!receivedTime) continue

        const delay = receivedTime - blockInfo.timestamp
        const delayInSeconds = (delay / 1000).toFixed(2)
        const emoji = getDelayEmoji(delay)
        printString += ` ${domain} ${emoji} ${delayInSeconds}s |`
    }

    console.log(printString)
}
