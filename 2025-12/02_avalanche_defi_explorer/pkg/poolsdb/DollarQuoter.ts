import { PoolsDB } from "./PoolsDB.ts"

export class DollarQuoter {
    private poolDb: PoolsDB
    constructor(poolDb: PoolsDB) {
        this.poolDb = poolDb
    }


}