'use server'

import { GlacierGetSubnet, GlacierGetL1Validators } from "./glacier"

export interface ValidatorData {
    nodeId: string
    version: string
    trackedSubnets: string[]
    lastAttempted: number
    lastSeenOnline: number
    ip: string
}

export async function getValidatorFromDiscoveryAPI(network: "fuji" | "mainnet"): Promise<ValidatorData[]> {

    const response = await fetch(`https://l1-validator-discovery-${network}.fly.dev/`, { next: { revalidate: 10 } })

    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
    }

    const data: ValidatorData[] = await response.json()

    const processedData = data.map((validator) => {
        const { version, ...rest } = validator
        let versionString = version || 'Unknown'
        if (version.includes('/')) {
            versionString = version.split('/')[1]
        }
        return { version: versionString || 'Unknown', ...rest } as ValidatorData
    })

    return processedData
}


export async function GlacierGetSubnetToValidators(network: "fuji" | "mainnet"): Promise<Map<string, string[]>> {
    const validators = await GlacierGetL1Validators(network)
    const subnetToValidators = new Map<string, string[]>()
    for (const validator of validators) {
        if (!validator.remainingBalance) continue;
        if (!subnetToValidators.has(validator.subnetId)) {
            subnetToValidators.set(validator.subnetId, [])
        }
        subnetToValidators.get(validator.subnetId)!.push(validator.nodeId)
    }
    return subnetToValidators
}

export async function getBlockchainNamesMapping(network: "fuji" | "mainnet", subnetIds: string[]): Promise<Map<string, string>> {
    const blockchainNamesMapping = new Map<string, string>()

    await Promise.all(
        subnetIds.map(async (subnetId) => {
            try {
                const subnet = await GlacierGetSubnet(network, subnetId)
                // Get first blockchain name if available
                const blockchainName = subnet.blockchains[0]?.blockchainName || 'Unknown Blockchain'
                blockchainNamesMapping.set(subnetId, blockchainName)
            } catch (error) {
                console.error(`Failed to fetch subnet ${subnetId}:`, error)
                blockchainNamesMapping.set(subnetId, 'Unknown Blockchain')
            }
        })
    )

    return blockchainNamesMapping
}
