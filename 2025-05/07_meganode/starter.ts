#!/usr/bin/env bun

import { getChain } from './rpc.js'
import { execSync } from 'child_process'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { chainIds } from './config.js'
import pThrottle from 'p-throttle';


const throttle = pThrottle({
    limit: 10,
    interval: 1000
});

//fetch subnet ids
const subnetIds = new Set<string>()
const vmIds = new Set<string>()

for (const chainId of chainIds) {
    console.log(`Fetching chain ${chainId}`)
    const chainTx = await throttle(() => getChain(chainId))()
    subnetIds.add(chainTx.unsignedTx.subnetID)
    vmIds.add(chainTx.unsignedTx.vmID)
    console.log(`Chain ${chainId}: Subnet ${chainTx.unsignedTx.subnetID}`)
}

subnetIds.delete("11111111111111111111111111111111LpoYY")

console.log('Copying plugins to avalanchego')

const sourcePlugin = 'srEXiWaHuhNyGwPUi444Tu47ZEDwxTWrbQiuD7FmgSAQ6X7Dy'
const pluginsDir = '/avalanchego/build/plugins'

// Copy plugin for each VM ID
for (const vmId of vmIds) {
    const targetPath = `${pluginsDir}/${vmId}`
    if (existsSync(targetPath)) {
        console.log(`Plugin already exists for VM ID ${vmId}`)
        continue
    }

    const sourcePath = `${pluginsDir}/${sourcePlugin}`
    execSync(`cp ${sourcePath} ${targetPath}`)
    console.log(`Copied plugin to ${targetPath}`)
}

console.log('Creating chain configs')

const configBaseDir = join(homedir(), '.avalanchego', 'configs', 'chains')
const chainConfig = {
    "pruning-enabled": false
}

for (const chainId of chainIds) {
    const chainConfigDir = join(configBaseDir, chainId)
    const configPath = join(chainConfigDir, 'config.json')

    mkdirSync(chainConfigDir, { recursive: true })
    writeFileSync(configPath, JSON.stringify(chainConfig, null, 2))
    console.log(`Created config for chain ${chainId}`)
}

const envContent = `
AVAGO_TRACK_SUBNETS=${Array.from(subnetIds).join(',')}
`;

writeFileSync('/app/.env', envContent);
