import { config } from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'

// Load .env from project root
const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.join(__dirname, '../.env') })

export function getRpcUrl(): string {
    const rpcUrl = process.env.RPC_URL
    if (!rpcUrl) {
        throw new Error('RPC_URL environment variable is not set')
    }
    return rpcUrl
}

export function getWsRpcUrl(): string {
    const rpcUrl = getRpcUrl()
    return rpcUrl.replace('http://', 'ws://').replace('/rpc', '/ws')
}
