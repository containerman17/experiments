import { BlockDB } from "../blockFetcher/BlockDB";
import { LazyBlock } from "../blockFetcher/lazy/LazyBlock";
import { LazyTx } from "../blockFetcher/lazy/LazyTx";
import { FastifyInstance, FastifyPluginOptions } from "fastify";
import SQLite from 'better-sqlite3';

export interface Indexer {
    initialize(): void;
    indexBlock(block: LazyBlock, txs: LazyTx[]): void;
    registerRoutes(fastify: FastifyInstance, options: FastifyPluginOptions): void;
    getVersionPrefix(): string;
}

export type CreateIndexerFunction = (blocksDb: BlockDB, indexingDb: SQLite.Database) => Indexer;
