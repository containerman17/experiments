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

    registerRoutes(fastify: FastifyInstance, options: FastifyPluginOptions): void {
        fastify.get('/metrics/:metricName', async (request, reply) => {
            const { metricName } = request.params as { metricName: string };
            const {
                startTimestamp,
                endTimestamp,
                timeInterval = 'day',
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
                query += ` AND timestamp > ?`;
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

            const response: any = {
                data: results,
                pageSize: validPageSize
            };

            if (hasNextPage && results.length > 0) {
                response.nextPageToken = results[results.length - 1]!.timestamp.toString();
            }

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

    getVersionPrefix(): string {
        return 'v2';
    }
}
export const createMetricsIndexer: CreateIndexerFunction = (blocksDb: BlockDB, indexingDb: SQLite.Database) => {
    return new MetricsIndexer(blocksDb, indexingDb);
}


function normalizeTimestamp(timestamp: number, timeInterval: number): number {
    const date = new Date(timestamp);

    switch (timeInterval) {
        case TIME_INTERVAL_HOUR:
            return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours());

        case TIME_INTERVAL_DAY:
            return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());

        case TIME_INTERVAL_WEEK:
            // Find Monday of this week in GMT
            const dayOfWeek = date.getUTCDay(); // 0=Sunday, 1=Monday, etc
            const daysToMonday = (dayOfWeek === 0) ? 6 : dayOfWeek - 1; // Convert Sunday=0 to 6 days back
            const monday = new Date(date);
            monday.setUTCDate(date.getUTCDate() - daysToMonday);
            return Date.UTC(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate());

        case TIME_INTERVAL_MONTH:
            return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);

        default:
            throw new Error(`Unknown time interval: ${timeInterval}`);
    }
}
