import SQLite from "better-sqlite3";
import { BlockDB } from "../blockFetcher/BlockDB";
import { CreateIndexerFunction, Indexer } from "./types";
import { LazyTx } from "../blockFetcher/lazy/LazyTx";
import { LazyBlock } from "../blockFetcher/lazy/LazyBlock";
import { FastifyInstance, FastifyPluginOptions } from "fastify";

const TIME_INTERVAL_HOUR = 0
const TIME_INTERVAL_DAY = 1
const TIME_INTERVAL_WEEK = 2
const TIME_INTERVAL_MONTH = 3

const METRIC_txCount = 0
const MERTIC_cumulativeContracts = 1


class MetricsIndexer implements Indexer {
    constructor(private blocksDb: BlockDB, private indexingDb: SQLite.Database) { }

    initialize(): void {
        this.indexingDb.exec(`
            CREATE TABLE IF NOT EXISTS metrics (
                timeInterval INTEGER NOT NULL,
                timestamp INTEGER NOT NULL,
                metric INTEGER NOT NULL,
                value INTEGER NOT NULL,
                PRIMARY KEY (timeInterval, timestamp, metric)
            ) WITHOUT ROWID
        `);
    }

    indexBlock(block: LazyBlock, txs: LazyTx[]): void {
        const blockTimestamp = block.timestamp * 1000; // Convert to milliseconds
        const txCount = txs.length;

        // Update metrics for all time intervals
        this.updateMetric(TIME_INTERVAL_HOUR, blockTimestamp, METRIC_txCount, txCount);
        this.updateMetric(TIME_INTERVAL_DAY, blockTimestamp, METRIC_txCount, txCount);
        this.updateMetric(TIME_INTERVAL_WEEK, blockTimestamp, METRIC_txCount, txCount);
        this.updateMetric(TIME_INTERVAL_MONTH, blockTimestamp, METRIC_txCount, txCount);
    }

    private updateMetric(timeInterval: number, timestamp: number, metric: number, increment: number): void {
        const normalizedTimestamp = normalizeTimestamp(timestamp, timeInterval);

        this.indexingDb.prepare(`
            INSERT INTO metrics (timeInterval, timestamp, metric, value) 
            VALUES (?, ?, ?, ?)
            ON CONFLICT(timeInterval, timestamp, metric) 
            DO UPDATE SET value = value + ?
        `).run(timeInterval, normalizedTimestamp, metric, increment, increment);
    }

    registerRoutes(fastify: FastifyInstance, options: FastifyPluginOptions): void { }
}
export const createMetricsIndexer: CreateIndexerFunction = (blocksDb: BlockDB, indexingDb: SQLite.Database) => {
    return new MetricsIndexer(blocksDb, indexingDb);
}


function normalizeTimestamp(timestamp: number, timeInterval: number): number {
    const date = new Date(timestamp);

    switch (timeInterval) {
        case TIME_INTERVAL_HOUR:
            return new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours()).getTime();

        case TIME_INTERVAL_DAY:
            return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

        case TIME_INTERVAL_WEEK:
            // Find Monday of this week in GMT
            const dayOfWeek = date.getUTCDay(); // 0=Sunday, 1=Monday, etc
            const daysToMonday = (dayOfWeek === 0) ? 6 : dayOfWeek - 1; // Convert Sunday=0 to 6 days back
            const monday = new Date(date);
            monday.setUTCDate(date.getUTCDate() - daysToMonday);
            return new Date(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate()).getTime();

        case TIME_INTERVAL_MONTH:
            return new Date(date.getFullYear(), date.getMonth(), 1).getTime();

        default:
            throw new Error(`Unknown time interval: ${timeInterval}`);
    }
}
