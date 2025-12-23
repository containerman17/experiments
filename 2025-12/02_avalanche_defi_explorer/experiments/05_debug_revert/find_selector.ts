// More comprehensive callback search
import { keccak256, toHex, toBytes } from 'viem'

const target = '0x4179b664'

// Try different callback name patterns
const prefixes = ['', 'pancake', 'ramses', 'pharaoh', 'thena', 'velocimeter', 'solidly', 'aerodrome', 'velodrome']
const versions = ['', 'V2', 'V3', 'v2', 'v3']

const callbacks = []
for (const prefix of prefixes) {
    for (const version of versions) {
        callbacks.push(`${prefix}${version}SwapCallback(int256,int256,bytes)`)
    }
}

console.log('Searching for selector:', target)
console.log('Testing', callbacks.length, 'combinations...\n')

for (const sig of callbacks) {
    const hash = keccak256(toBytes(sig))
    const selector = hash.slice(0, 10)
    if (selector.toLowerCase() === target.toLowerCase()) {
        console.log(`✅ MATCH FOUND: ${sig}`)
        console.log(`   Selector: ${selector}`)
        break
    }
}
