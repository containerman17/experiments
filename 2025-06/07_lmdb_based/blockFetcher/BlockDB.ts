import lmdb from 'node-lmdb';
import { Block } from './evmTypes';
import { StoredBlock } from './BatchRpc';

export class BlockDB {
    private db: lmdb.Dbi;

    constructor(path: string) {
        const env = new lmdb.Env();
        env.open({
            path: path,
            mapSize: 4 * 1024 * 1024 * 1024,
            maxDbs: 3
        });

        const dbi = env.openDbi({
            name: "BlockDB",
            create: true // will create if database did not exist
        })

        this.db = dbi;
    }

    writeBlocks(blocks: StoredBlock[]) {

    }
}
