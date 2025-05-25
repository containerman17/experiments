// #!/usr/bin/env bun


// import { chainIds } from "./config";

// import { createPublicClient, http } from 'viem'

// let port = 9000
// async function check(chainId: string) {
//     port += 2
//     const url = `http://65.21.140.118:${port}/ext/bc/${chainId}/rpc`

//     const client = createPublicClient({
//         transport: http(url)
//     })

//     try {
//         const block = await client.getBlockNumber()
//         console.log(`✅ ${chainId} is ready, block: ${block}`)
//     } catch (error) {
//         console.log(`❌ ${chainId} is not ready`, error)
//     }
// }

// await Promise.all(chainIds.map(check))
