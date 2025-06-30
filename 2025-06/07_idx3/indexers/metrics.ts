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
const METRIC_cumulativeContracts = 1

interface MetricResult {
    timestamp: number;
    value: number;
}

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

    indexBlocks(blocks: { block: LazyBlock, txs: LazyTx[] }[]): void {
        for (const { block, txs } of blocks) {
            const blockTimestamp = block.timestamp; // Keep in seconds, don't multiply by 1000
            const txCount = txs.length;

            // Update metrics for all time intervals
            this.updateMetric(TIME_INTERVAL_HOUR, blockTimestamp, METRIC_txCount, txCount);
            this.updateMetric(TIME_INTERVAL_DAY, blockTimestamp, METRIC_txCount, txCount);
            this.updateMetric(TIME_INTERVAL_WEEK, blockTimestamp, METRIC_txCount, txCount);
            this.updateMetric(TIME_INTERVAL_MONTH, blockTimestamp, METRIC_txCount, txCount);
        }
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

    registerRoutes(fastify: FastifyInstance, options: FastifyPluginOptions): void {
        fastify.get('/metrics/:metricName', async (request, reply) => {
            const { metricName } = request.params as { metricName: string };
            const {
                startTimestamp,
                endTimestamp,
                timeInterval = 'hour',
                pageSize = 100,
                pageToken
            } = request.query as {
                startTimestamp?: number;
                endTimestamp?: number;
                timeInterval?: string;
                pageSize?: number;
                pageToken?: string;
            };

            // Map metric name to constant
            const metricId = this.getMetricId(metricName);
            if (metricId === -1) {
                return reply.code(400).send({ error: `Unknown metric: ${metricName}` });
            }

            // Map time interval to constant
            const timeIntervalId = this.getTimeIntervalId(timeInterval);
            if (timeIntervalId === -1) {
                return reply.code(400).send({ error: `Invalid timeInterval: ${timeInterval}` });
            }

            // Validate pageSize
            const validPageSize = Math.min(Math.max(pageSize, 1), 2160);

            // Build query
            let query = `
                SELECT timestamp, value 
                FROM metrics 
                WHERE timeInterval = ? AND metric = ?
            `;
            const params: any[] = [timeIntervalId, metricId];

            if (startTimestamp) {
                query += ` AND timestamp >= ?`;
                params.push(startTimestamp);
            }

            if (endTimestamp) {
                query += ` AND timestamp <= ?`;
                params.push(endTimestamp);
            }

            if (pageToken) {
                query += ` AND timestamp < ?`;
                params.push(parseInt(pageToken));
            }

            query += ` ORDER BY timestamp DESC LIMIT ?`;
            params.push(validPageSize + 1); // Get one extra to check if there's a next page

            const results = this.indexingDb.prepare(query).all(...params) as MetricResult[];

            // Check if there's a next page
            const hasNextPage = results.length > validPageSize;
            if (hasNextPage) {
                results.pop(); // Remove the extra result
            }

            // Backfill missing periods with zero values to match Glacier behavior
            const backfilledResults = this.backfillZeros(results, timeIntervalId, startTimestamp, endTimestamp);

            const response: any = {
                results: backfilledResults.slice(0, validPageSize),
                nextPageToken: hasNextPage && backfilledResults.length > 0
                    ? backfilledResults[Math.min(validPageSize - 1, backfilledResults.length - 1)]!.timestamp.toString()
                    : undefined
            };

            return response;
        });
    }

    private getMetricId(metricName: string): number {
        switch (metricName) {
            case 'txCount': return METRIC_txCount;
            case 'cumulativeContracts': return METRIC_cumulativeContracts;
            default: return -1;
        }
    }

    private getTimeIntervalId(timeInterval: string): number {
        switch (timeInterval) {
            case 'hour': return TIME_INTERVAL_HOUR;
            case 'day': return TIME_INTERVAL_DAY;
            case 'week': return TIME_INTERVAL_WEEK;
            case 'month': return TIME_INTERVAL_MONTH;
            default: return -1;
        }
    }

    private backfillZeros(results: MetricResult[], timeInterval: number, startTimestamp?: number, endTimestamp?: number): MetricResult[] {
        if (results.length === 0) return results;

        const backfilled: MetricResult[] = [];
        const resultMap = new Map(results.map(r => [r.timestamp, r.value]));

        const oldest = results[results.length - 1]!.timestamp;
        const newest = results[0]!.timestamp;

        const start = startTimestamp ? Math.max(startTimestamp, oldest) : oldest;
        const end = endTimestamp ? Math.min(endTimestamp, newest) : newest;

        let current = newest;
        while (current >= start) {
            backfilled.push({
                timestamp: current,
                value: resultMap.get(current) || 0
            });
            current = this.getPreviousTimestamp(current, timeInterval);
        }

        return backfilled;
    }

    private getPreviousTimestamp(timestamp: number, timeInterval: number): number {
        const date = new Date(timestamp * 1000);

        switch (timeInterval) {
            case TIME_INTERVAL_HOUR:
                return timestamp - 3600;
            case TIME_INTERVAL_DAY:
                return timestamp - 86400;
            case TIME_INTERVAL_WEEK:
                return timestamp - 604800;
            case TIME_INTERVAL_MONTH:
                date.setUTCMonth(date.getUTCMonth() - 1);
                return Math.floor(date.getTime() / 1000);
            default:
                return timestamp;
        }
    }
}
export const createMetricsIndexer: CreateIndexerFunction = (blocksDb: BlockDB, indexingDb: SQLite.Database) => {
    return new MetricsIndexer(blocksDb, indexingDb);
}


function normalizeTimestamp(timestamp: number, timeInterval: number): number {
    const date = new Date(timestamp * 1000); // Convert to milliseconds for Date constructor

    switch (timeInterval) {
        case TIME_INTERVAL_HOUR:
            return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours()) / 1000);

        case TIME_INTERVAL_DAY:
            return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 1000);

        case TIME_INTERVAL_WEEK:
            const dayOfWeek = date.getUTCDay();
            const daysToMonday = (dayOfWeek === 0) ? 6 : dayOfWeek - 1;
            const monday = new Date(date);
            monday.setUTCDate(date.getUTCDate() - daysToMonday);
            return Math.floor(Date.UTC(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate()) / 1000);

        case TIME_INTERVAL_MONTH:
            return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / 1000);

        default:
            throw new Error(`Unknown time interval: ${timeInterval}`);
    }
}
