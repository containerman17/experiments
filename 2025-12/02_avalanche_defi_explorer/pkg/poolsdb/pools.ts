import { type PoolProvider } from '../providers/_types.ts'
import { type Log } from 'viem'
const BLOCKS_BEHIND_LOOKUP = (10 * 24 * 60 * 60 * 1000) / 1250 //10 days with 1250ms block time

export class PoolsDB {
    private pools: PoolProvider[]

    constructor(_pools: PoolProvider[]) {
        this.pools = _pools
    }

    async catchUp(rpcUrl: string, blockNumber: number) {
        /*
        TODO: if no data in the db, start from BLOCKS_BEHIND_LOOKUP, otheherwise when stopped
        fetch all logs in a group of 1000 blocks via eth_getLogs
        then split those logs by block and record with a key block number decimal padded to 12 symbold with zeroes

        */
    }

    async processLogs(blockNumber: number, logs: Log[]) {

    }
}