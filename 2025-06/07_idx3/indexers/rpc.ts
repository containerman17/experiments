import SQLite from "better-sqlite3";
import { BlockDB } from "../blockFetcher/BlockDB";
import { CreateIndexerFunction, Indexer } from "./types";
import { LazyTx, lazyTxToReceipt } from "../blockFetcher/lazy/LazyTx";
import { LazyBlock } from "../blockFetcher/lazy/LazyBlock";
import { FastifyInstance, FastifyPluginOptions } from "fastify";
import { lazyBlockToBlock } from "../blockFetcher/lazy/LazyBlock";

class RPCIndexer implements Indexer {
    constructor(private blocksDb: BlockDB, private indexingDb: SQLite.Database) {

    }

    initialize(): void {
        // No init - just use existing tables
    }

    indexBlocks(blocks: { block: LazyBlock, txs: LazyTx[] }[]): void {
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
        if (request.method === 'eth_chainId') {
            return { result: '0x' + this.blocksDb.getEvmChainId().toString(16) };
        } else if (request.method === 'eth_getTransactionReceipt') {//tx receipt
            return { error: { code: -32015, message: 'eth_getTransactionReceipt is not implemented yet - no hash to tx number lookup table. TODO: implement' } };
        } else if (request.method === 'eth_getBlockByNumber') {
            const blockNumber = request.params[0];
            const { block, txs } = this.blocksDb.getBlockWithTransactions(blockNumber);
            return { result: lazyBlockToBlock(block, txs) };
        } else {
            return { error: { code: -32601, message: 'Method not found. Implement it in ./indexers/rpc.ts' } };
        }
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
