// Fetch contract source code from Routescan API
const BASE_URL = "https://api.routescan.io/v2/network/mainnet/evm/43114/etherscan/api"
const API_KEY = "YourApiKeyToken"
const address = "0x11476e10eb79ddffa6f2585be526d2bd840c3e20"

const url = `${BASE_URL}?module=contract&action=getsourcecode&address=${address}&apikey=${API_KEY}`

console.log('Fetching source code for:', address)
console.log('URL:', url)

const response = await fetch(url)
const data = await response.json()

if (data.status !== "1") {
    console.error('API error:', data.message)
    process.exit(1)
}

const result = data.result[0]

console.log('\n=== Contract Info ===')
console.log('Name:', result.ContractName)
console.log('Compiler:', result.CompilerVersion)
console.log('Proxy:', result.Proxy)
console.log('Implementation:', result.Implementation)

// Save source code
const fs = await import('fs')
const outputDir = '/tmp/pool_source'
fs.mkdirSync(outputDir, { recursive: true })

// Parse source code
let sourceCode = result.SourceCode

// Handle double-braced JSON format
if (sourceCode.startsWith("{{")) {
    sourceCode = sourceCode.slice(1, -1)
}

try {
    const parsed = JSON.parse(sourceCode)

    if (parsed.sources) {
        console.log('\n=== Source Files ===')
        for (const [filePath, content] of Object.entries(parsed.sources)) {
            const fullPath = `${outputDir}/${filePath.replace(/\//g, '_')}`
            fs.writeFileSync(fullPath, content.content)
            console.log('Saved:', fullPath)
        }
    }
} catch {
    // Plain solidity source
    const solPath = `${outputDir}/${result.ContractName}.sol`
    fs.writeFileSync(solPath, sourceCode)
    console.log('\n=== Source File ===')
    console.log('Saved:', solPath)
}

// Save ABI
const abiPath = `${outputDir}/abi.json`
fs.writeFileSync(abiPath, result.ABI)
console.log('Saved ABI:', abiPath)

console.log('\n✅ Done! Check /tmp/pool_source for all files')
