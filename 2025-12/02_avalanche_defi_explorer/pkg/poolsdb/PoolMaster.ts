import { type Leg } from "../Hayabusa.ts"
import { loadPools, type StoredPool } from "./PoolLoader.ts"


export class PoolMaster {
    private pools: Map<string, StoredPool>

    private tokenToPoolIndex = new Map<string, Set<string>>()
    private neighborsIndex = new Map<string, Set<string>>()


    constructor(filePath: string) {
        this.pools = loadPools(filePath)
        for (const pool of this.pools.values()) {
            for (const token of pool.tokens) {
                //tokenToPoolIndex
                let set = this.tokenToPoolIndex.get(token)
                if (!set) {
                    set = new Set<string>()
                    this.tokenToPoolIndex.set(token, set)
                }
                set.add(pool.address)

                // neighborsIndex
                let existingNeighbors = this.neighborsIndex.get(token)
                if (!existingNeighbors) {
                    existingNeighbors = new Set<string>()
                    this.neighborsIndex.set(token, existingNeighbors)
                }
                pool.tokens.forEach(poolToken => poolToken !== token && existingNeighbors.add(poolToken))
            }
        }
    }

    public getAllCoins(): string[] {
        return Array.from(this.neighborsIndex.entries())
            .sort((a, b) => b[1].size - a[1].size)
            .map(([token]) => token)
    }

    /**
     * Find routes from tokenFrom to tokenTo, searching progressively deeper.
     * Stops searching deeper once stopAt routes are found.
     * Routes are sorted by swap count (higher activity pools first).
     * @param stopAt - if we have >= this many routes, don't search deeper (default 10)
     */
    public findRoutes(tokenFrom: string, tokenTo: string, stopAt: number = 10): Leg[][] {
        tokenFrom = tokenFrom.toLowerCase()
        tokenTo = tokenTo.toLowerCase()

        const routes: Leg[][] = []

        // 1-hop: wrap single legs in arrays for consistent return type
        const oneHops = this.getOneHopRoutes(tokenFrom, tokenTo)
        for (const leg of oneHops) {
            routes.push([leg])
        }
        if (routes.length >= stopAt) return this.sortRoutesBySwapCount(routes)

        // 2-hop
        const twoHops = this.getTwoHopRoutes(tokenFrom, tokenTo)
        for (const route of twoHops) routes.push(route)
        if (routes.length >= stopAt) return this.sortRoutesBySwapCount(routes)

        // 3-hop
        const threeHops = this.getThreeHopRoutes(tokenFrom, tokenTo)
        for (const route of threeHops) routes.push(route)
        if (routes.length >= stopAt) return this.sortRoutesBySwapCount(routes)

        // 4-hop
        const fourHops = this.getFourHopRoutes(tokenFrom, tokenTo)
        for (const route of fourHops) routes.push(route)

        return this.sortRoutesBySwapCount(routes)
    }

    /**
     * Sort routes by swap count (higher first).
     * For multi-hop routes, uses the minimum swap count across all pools (weakest link).
     */
    private sortRoutesBySwapCount(routes: Leg[][]): Leg[][] {
        return routes.sort((a, b) => {
            const aMinSwapCount = Math.min(...a.map(leg => this.pools.get(leg.pool)!.swapCount))
            const bMinSwapCount = Math.min(...b.map(leg => this.pools.get(leg.pool)!.swapCount))
            return bMinSwapCount - aMinSwapCount
        })
    }

    private getOneHopRoutes(tokenFrom: string, tokenTo: string): Leg[] {
        if (tokenFrom === tokenTo) return []
        const fromPools = this.tokenToPoolIndex.get(tokenFrom)
        if (!fromPools) return []
        const toPools = this.tokenToPoolIndex.get(tokenTo)
        if (!toPools) return []

        const mutualPools = fromPools.intersection(toPools)

        const routes = Array.from(mutualPools).map(poolAddress => {
            const pool = this.pools.get(poolAddress)!
            return {
                pool: pool.address,
                poolType: pool.poolType,
                tokenIn: tokenFrom,
                tokenOut: tokenTo
            }
        })
        return routes
    }

    private twoHopCache = new Map<string, Map<string, Leg[][]>>()

    private getTwoHopRoutes(tokenFrom: string, tokenTo: string): Leg[][] {
        if (!this.twoHopCache.has(tokenFrom)) {
            this.twoHopCache.set(tokenFrom, new Map<string, Leg[][]>())
        }

        if (this.twoHopCache.get(tokenFrom)!.has(tokenTo)) {
            return this.twoHopCache.get(tokenFrom)!.get(tokenTo)!
        }

        const fromNeighbours = this.neighborsIndex.get(tokenFrom)
        if (!fromNeighbours) return []
        const toNeighbours = this.neighborsIndex.get(tokenTo)
        if (!toNeighbours) return []

        const mutualNeighbours = fromNeighbours.intersection(toNeighbours)

        const routes: Leg[][] = []

        for (const intermediate of mutualNeighbours) {
            // Skip if the intermediate is one of our endpoints
            if (intermediate === tokenFrom || intermediate === tokenTo) continue

            const firstHops = this.getOneHopRoutes(tokenFrom, intermediate)
            const secondHops = this.getOneHopRoutes(intermediate, tokenTo)

            // Cartesian product of first and second hops (with pool-reuse filtering)
            for (const first of firstHops) {
                for (const second of secondHops) {
                    // Skip if second leg reuses the same pool as first
                    if (first.pool === second.pool) continue
                    routes.push([first, second])
                }
            }
        }

        this.twoHopCache.get(tokenFrom)!.set(tokenTo, routes)
        return routes
    }

    private threeHopCache = new Map<string, Map<string, Leg[][]>>()
    private getThreeHopRoutes(tokenFrom: string, tokenTo: string): Leg[][] {
        if (!this.threeHopCache.has(tokenFrom)) {
            this.threeHopCache.set(tokenFrom, new Map<string, Leg[][]>())
        }

        if (this.threeHopCache.get(tokenFrom)!.has(tokenTo)) {
            return this.threeHopCache.get(tokenFrom)!.get(tokenTo)!
        }

        const toNeighbours = this.neighborsIndex.get(tokenTo)
        if (!toNeighbours) return []

        const routes: Leg[][] = []

        for (const penultimate of toNeighbours) {
            // Skip if penultimate is one of our endpoints
            if (penultimate === tokenFrom || penultimate === tokenTo) continue

            // 2-hop routes from start to penultimate
            const twoHops = this.getTwoHopRoutes(tokenFrom, penultimate)
            // 1-hop routes from penultimate to end
            const finalLegs = this.getOneHopRoutes(penultimate, tokenTo)

            // Compose them with pool-reuse filtering
            for (const twoHop of twoHops) {
                const usedPools = new Set(twoHop.map(leg => leg.pool))

                for (const finalLeg of finalLegs) {
                    // Skip if final leg reuses a pool from the 2-hop
                    if (usedPools.has(finalLeg.pool)) continue

                    routes.push([...twoHop, finalLeg])
                }
            }
        }

        return routes
    }

    private getFourHopRoutes(tokenFrom: string, tokenTo: string): Leg[][] {
        const toNeighbours = this.neighborsIndex.get(tokenTo)
        if (!toNeighbours) return []

        const routes: Leg[][] = []

        for (const penultimate of toNeighbours) {
            // Skip if penultimate is one of our endpoints
            if (penultimate === tokenFrom || penultimate === tokenTo) continue

            // 3-hop routes from start to penultimate
            const threeHops = this.getThreeHopRoutes(tokenFrom, penultimate)
            // 1-hop routes from penultimate to end
            const finalLegs = this.getOneHopRoutes(penultimate, tokenTo)

            // Compose them with pool-reuse filtering
            for (const threeHop of threeHops) {
                const usedPools = new Set(threeHop.map(leg => leg.pool))

                for (const finalLeg of finalLegs) {
                    // Skip if final leg reuses a pool from the 3-hop
                    if (usedPools.has(finalLeg.pool)) continue

                    routes.push([...threeHop, finalLeg])
                }
            }
        }

        return routes
    }
}