import { BlockDB } from "../blockFetcher/BlockDB";
import { LazyBlock } from "../blockFetcher/LazyBlock";
import { LazyTx } from "../blockFetcher/LazyTx";
import { FastifyInstance, FastifyPluginOptions } from "fastify";
import SQLite from 'better-sqlite3';

export interface Indexer {
    indexBlock(block: LazyBlock, txs: LazyTx[]): void;
    registerRoutes(fastify: FastifyInstance, options: FastifyPluginOptions): void;
}

export type CreateIndexerFunction = (blocksDb: BlockDB, indexingDb: SQLite.Database) => Indexer;
