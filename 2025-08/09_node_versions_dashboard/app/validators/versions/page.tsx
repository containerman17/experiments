
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import TimeAgo from 'javascript-time-ago'
import en from 'javascript-time-ago/locale/en'
import { GlacierGetSubnetToValidators, getValidatorFromDiscoveryAPI, getBlockchainNamesMapping } from "../apis"
import Link from "next/link"

// Initialize TimeAgo with English locale
TimeAgo.addDefaultLocale(en)

export default async function OutdatedValidators({ searchParams }: { searchParams: Promise<{ network?: string }> }) {
    const params = await searchParams
    const network: "fuji" | "mainnet" = params.network === "fuji" ? "fuji" : "mainnet"
    // Get subnet to validators mapping from Glacier
    const subnetToValidators = await GlacierGetSubnetToValidators(network)

    // Get blockchain names mapping for only the subnets we have
    const subnetIds = Array.from(subnetToValidators.keys())
    const blockchainNamesMapping = await getBlockchainNamesMapping(network, subnetIds)

    // Create version lookup map: nodeId => version
    const versionLookup = new Map<string, string>()
    let lastUpdated = 0
    for (const validator of await getValidatorFromDiscoveryAPI(network)) {
        versionLookup.set(validator.nodeId, validator.version)
        if (validator.lastSeenOnline > lastUpdated) {
            lastUpdated = validator.lastSeenOnline
        }
    }

    // Build subnet data structure: subnet -> version -> count
    const subnetData = new Map<string, Map<string, number>>()
    let totalValidatorCount = 0

    for (const [subnetId, nodeIds] of subnetToValidators) {
        const versionCounts = new Map<string, number>()

        for (const nodeId of nodeIds) {
            const version = versionLookup.get(nodeId) || 'Unknown'
            versionCounts.set(version, (versionCounts.get(version) || 0) + 1)
            totalValidatorCount++
        }

        subnetData.set(subnetId, versionCounts)
    }

    const timeAgo = new TimeAgo('en-US')
    // Find and sort all versions
    const allVersions = Array.from(versionLookup.values()).filter(v => v !== 'Unknown')
    const sortedVersions = allVersions.length > 0
        ? [...new Set(allVersions)].sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }))
        : []
    const latestVersion = sortedVersions[0] || ''

    // Version color mapping
    const getVersionStyle = (version: string) => {
        if (version === 'Unknown') return { color: 'red-600' }

        const versionIndex = sortedVersions.indexOf(version)
        switch (versionIndex) {
            case 0: return { color: 'green-500' }    // Latest
            case 1: return { color: 'cyan-500' }     // 1 behind  
            case 2: return { color: 'blue-500' }     // 2 behind
            case 3: return { color: 'yellow-500' }   // 3 behind
            case 4: return { color: 'orange-500' }   // 4 behind
            default: return { color: 'red-500' }     // 5+ behind (6+ versions behind)
        }
    }

    // Convert to array and sort by total validators (descending)
    const subnets = Array.from(subnetData.entries())
        .map(([subnetId, versions]) => {
            const totalValidators = Array.from(versions.values()).reduce((sum, count) => sum + count, 0)
            return { subnetId, versions, totalValidators }
        })
        .sort((a, b) => b.totalValidators - a.totalValidators)

    return (
        <div className="container mx-auto py-6 space-y-6">
            <div>
                <div className="flex items-center justify-between mb-4">
                    <h1 className="text-3xl font-bold">Validator Versions by Subnet</h1>
                    <div className="inline-flex rounded-full bg-muted p-1">
                        <Link
                            href="/validators/versions?network=fuji"
                            className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${network === "fuji" ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                        >
                            Fuji
                        </Link>
                        <Link
                            href="/validators/versions?network=mainnet"
                            className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${network === "mainnet" ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                        >
                            Mainnet
                        </Link>
                    </div>
                </div>
                <p className="text-muted-foreground mb-4">
                    Monitoring {subnets.length} subnets • {totalValidatorCount} validators total • Latest: {latestVersion} • Last updated {lastUpdated === 0 ? 'Never' : timeAgo.format(lastUpdated)}
                </p>
                <div className="flex gap-2 text-xs flex-wrap">
                    <div className="flex items-center gap-1">
                        <div className="w-3 h-3 bg-green-500 rounded"></div>
                        <span>Latest</span>
                    </div>
                    <div className="flex items-center gap-1">
                        <div className="w-3 h-3 bg-cyan-500 rounded"></div>
                        <span>1 behind</span>
                    </div>
                    <div className="flex items-center gap-1">
                        <div className="w-3 h-3 bg-blue-500 rounded"></div>
                        <span>2 behind</span>
                    </div>
                    <div className="flex items-center gap-1">
                        <div className="w-3 h-3 bg-yellow-500 rounded"></div>
                        <span>3 behind</span>
                    </div>
                    <div className="flex items-center gap-1">
                        <div className="w-3 h-3 bg-orange-500 rounded"></div>
                        <span>4 behind</span>
                    </div>
                    <div className="flex items-center gap-1">
                        <div className="w-3 h-3 bg-red-500 rounded"></div>
                        <span>5+ behind</span>
                    </div>
                    <div className="flex items-center gap-1">
                        <div className="w-3 h-3 bg-red-600 rounded"></div>
                        <span>Unknown</span>
                    </div>
                </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
                {subnets.map(({ subnetId, versions, totalValidators }) => {
                    const blockchainName = blockchainNamesMapping.get(subnetId) || 'Unknown Blockchain'
                    return (
                        <Card key={subnetId}>
                            <CardHeader className="pb-4">
                                <CardTitle className="text-lg">
                                    {blockchainName}
                                </CardTitle>
                                <CardDescription className="font-mono text-xs">
                                    {subnetId}
                                </CardDescription>
                                <CardDescription>
                                    {totalValidators} validators total
                                </CardDescription>
                            </CardHeader>
                            <CardContent>
                                <div className="space-y-2">
                                    {Array.from(versions.entries())
                                        .sort((a, b) => {
                                            // Sort by version number descending (1.13.5 -> 1.13.4 -> etc.)
                                            if (a[0] === 'Unknown') return 1
                                            if (b[0] === 'Unknown') return -1
                                            return b[0].localeCompare(a[0], undefined, { numeric: true, sensitivity: 'base' })
                                        })
                                        .map(([version, count]) => {
                                            const percentage = Math.round((count / totalValidators) * 100)
                                            const isLatest = version === latestVersion
                                            const style = getVersionStyle(version)

                                            return (
                                                <div key={version} className="space-y-1">
                                                    <div className="flex items-center justify-between text-xs">
                                                        <div className="flex items-center gap-2">
                                                            <span className="font-mono text-xs">
                                                                {version}
                                                            </span>
                                                            {isLatest && (
                                                                <span className="text-xs text-green-600 font-medium">latest</span>
                                                            )}
                                                        </div>
                                                        <div className="font-semibold">
                                                            {count} ({percentage}%)
                                                        </div>
                                                    </div>
                                                    <div className="relative">
                                                        <div className="w-full bg-muted h-2 rounded-full overflow-hidden">
                                                            <div
                                                                className={`h-full transition-all duration-300 bg-${style.color}`}
                                                                style={{ width: `${percentage}%` }}
                                                            />
                                                        </div>
                                                    </div>
                                                </div>
                                            )
                                        })}
                                </div>
                            </CardContent>
                        </Card>
                    )
                })}
            </div>

            {subnets.length === 0 && (
                <div className="text-center py-12 text-muted-foreground">
                    No validator data available
                </div>
            )}
        </div>
    )
}

