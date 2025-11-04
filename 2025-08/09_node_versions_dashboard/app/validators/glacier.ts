"use server"

export interface BLSCredentials {
    publicKey: string
    proofOfPossession: string
}

export interface Owner {
    addresses: string[]
    threshold: number
}

export interface GlacierL1Validator {
    validationId: string
    validationIdHex: string
    creationTimestamp: number
    nodeId: string
    subnetId: string
    weight: number
    remainingBalance: number
    blsCredentials: BLSCredentials
    remainingBalanceOwner: Owner
    deactivationOwner: Owner
}

export interface GlacierL1ValidatorsResponse {
    validators: GlacierL1Validator[]
    blockHeight: string
    nextPageToken?: string
}



export async function GlacierGetL1Validators(network: "fuji" | "mainnet"): Promise<GlacierL1Validator[]> {
    const allValidators: GlacierL1Validator[] = []
    let nextPageToken: string | undefined = undefined

    do {
        const url = nextPageToken
            ? `https://glacier-api.avax.network/v1/networks/${network}/l1Validators?pageSize=100&pageToken=${nextPageToken}`
            : `https://glacier-api.avax.network/v1/networks/${network}/l1Validators?pageSize=100`

        const headers: HeadersInit = {}
        if (process.env.GLACIER_API_KEY) {
            headers['x-glacier-api-key'] = process.env.GLACIER_API_KEY
        }

        const response = await fetch(url, {
            next: { revalidate: 60 * 60 },
            headers
        })//cache for an hour

        if (!response.ok) {
            const body = await response.text()
            console.log('Glacier API error response body:', body)
            throw new Error(`HTTP error! status: ${response.status}`)
        }

        const data: GlacierL1ValidatorsResponse = await response.json()

        allValidators.push(...data.validators)
        nextPageToken = data.nextPageToken

    } while (nextPageToken)

    return allValidators
}


export interface GlacierBlockchain {
    createBlockTimestamp: number
    createBlockNumber: string
    blockchainId: string
    vmId: string
    subnetId: string
    blockchainName: string
    evmChainId: number
}

export interface GlacierSubnetResponse {
    createBlockTimestamp: number
    createBlockIndex: string
    subnetId: string
    ownerAddresses: string[]
    threshold: number
    locktime: number
    isL1: boolean
    blockchains: GlacierBlockchain[]
}

import pLimit from 'p-limit'
const glacierLimit = pLimit(3)

const subnetsCache = new Map<string, GlacierSubnetResponse>()

export async function GlacierGetSubnet(network: "fuji" | "mainnet", subnetId: string): Promise<GlacierSubnetResponse> {
    const cacheKey = `${network}:${subnetId}`

    // Try cache first
    if (subnetsCache.has(cacheKey)) {
        return subnetsCache.get(cacheKey)!
    }

    const url = `https://glacier-api.avax.network/v1/networks/${network}/subnets/${subnetId}`

    const headers: HeadersInit = {}
    if (process.env.GLACIER_API_KEY) {
        headers['x-glacier-api-key'] = process.env.GLACIER_API_KEY
    }

    // Use p-limit to throttle requests
    const data: GlacierSubnetResponse = await glacierLimit(async () => {
        const response = await fetch(url, {
            next: { revalidate: 60 * 60 * 10 },
            headers
        }) // cache for 10 hours

        if (!response.ok) {
            const body = await response.text()
            console.log('Glacier API error response body:', body)
            throw new Error(`HTTP error! status: ${response.status}`)
        }

        return await response.json()
    })

    // Set cache
    subnetsCache.set(cacheKey, data)
    return data
}

