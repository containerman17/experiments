import SQLite from "better-sqlite3";
import { BlockDB } from "../blockFetcher/BlockDB";
import { CreateIndexerFunction, Indexer } from "./types";
import { LazyTx } from "../blockFetcher/lazy/LazyTx";
import { LazyBlock } from "../blockFetcher/lazy/LazyBlock";
import { FastifyInstance, FastifyPluginOptions } from "fastify";

class RPCIndexer implements Indexer {
    constructor(private blocksDb: BlockDB, private indexingDb: SQLite.Database) {

    }

    initialize(): void {
        // No init - just use existing tables
    }

    indexBlock(block: LazyBlock, txs: LazyTx[]): void {
        //No actual indexing, just raw block ops
    }

    registerRoutes(fastify: FastifyInstance, options: FastifyPluginOptions): void {
        const handler = (request: any, reply: any) => {
            const requests = request.body as RPCRequests;
            if (Array.isArray(requests)) {
                return requests.map(req => this.handleRPCRequest(req));
            } else {
                return this.handleRPCRequest(requests);
            }
        };

        fastify.post('/rpc', handler);
    }

    private handleRPCRequest(request: RPCRequest): any {
        return {
            result: "method was " + request.method
        }
    }

    getVersionPrefix(): string {
        return 'v1';
    }
}
export const createRPCIndexer: CreateIndexerFunction = (blocksDb, indexingDb) => {
    return new RPCIndexer(blocksDb, indexingDb);
}

type RPCRequests = RPCRequest[] | RPCRequest;

type RPCRequest = {
    method: string;
    params: any[];
}
