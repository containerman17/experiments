#!/usr/bin/env bun


import { chainIds } from "./config";

import { createPublicClient, http } from 'viem'

for (const chainId of chainIds) {
    const url = `http://127.0.0.1:9652/ext/bc/${chainId}/rpc`

    const client = createPublicClient({
        transport: http(url)
    })

    try {
        const block = await client.getBlockNumber()
        console.log(`✅ ${chainId} is ready, block: ${block}`)
    } catch (error) {
        console.log(`❌ ${chainId} is not ready`)
    }
}
