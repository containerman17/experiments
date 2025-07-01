import SQLite from "better-sqlite3";
import { BlockDB } from "../blockFetcher/BlockDB";
import { CreateIndexerFunction, Indexer } from "./types";
import { LazyTx } from "../blockFetcher/lazy/LazyTx";
import { LazyBlock } from "../blockFetcher/lazy/LazyBlock";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { LazyTraces, LazyTraceCall } from "../blockFetcher/lazy/LazyTrace";

// Define schemas for the metrics API
const MetricQuerySchema = z.object({
    startTimestamp: z.coerce.number().optional().openapi({
        example: 1640995200,
        description: 'Start timestamp for the query range'
    }),
    endTimestamp: z.coerce.number().optional().openapi({
        example: 1641081600,
        description: 'End timestamp for the query range'
    }),
    timeInterval: z.enum(['hour', 'day', 'week', 'month']).optional().default('hour').openapi({
        example: 'hour',
        description: 'Time interval for aggregation'
    }),
    pageSize: z.coerce.number().optional().default(100).openapi({
        example: 100,
        description: 'Number of results per page'
    }),
    pageToken: z.string().optional().openapi({
        example: '1641081600',
        description: 'Token for pagination'
    })
});

const MetricResultSchema = z.object({
    timestamp: z.number().openapi({
        example: 1640995200,
        description: 'Timestamp of the metric data point'
    }),
    value: z.number().openapi({
        example: 1000,
        description: 'Metric value'
    })
}).openapi('MetricResult');

const MetricResponseSchema = z.object({
    results: z.array(MetricResultSchema).openapi({
        description: 'Array of metric results'
    }),
    nextPageToken: z.string().optional().openapi({
        description: 'Token for fetching the next page'
    })
}).openapi('MetricResponse');

const TIME_INTERVAL_HOUR = 0
const TIME_INTERVAL_DAY = 1
const TIME_INTERVAL_WEEK = 2
const TIME_INTERVAL_MONTH = 3

const METRIC_txCount = 0
const METRIC_cumulativeContracts = 1

// Define available metrics
const METRICS = {
    txCount: METRIC_txCount,
    cumulativeContracts: METRIC_cumulativeContracts,
} as const;

interface MetricResult {
    timestamp: number;
    value: number;
}

function isCumulativeMetric(metricId: number): boolean {
    return metricId === METRIC_cumulativeContracts;
}

class MetricsIndexer implements Indexer {
    private cumulativeContractCount = 0;

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

        // Initialize cumulative contract count from existing data
        const result = this.indexingDb.prepare(`
            SELECT MAX(value) as maxValue 
            FROM metrics 
            WHERE metric = ? AND timeInterval = ?
        `).get(METRIC_cumulativeContracts, TIME_INTERVAL_HOUR) as { maxValue: number | null };

        this.cumulativeContractCount = result?.maxValue || 0;
    }

    indexBlock(block: LazyBlock, txs: LazyTx[], traces: LazyTraces | undefined): void {
        const blockTimestamp = block.timestamp;
        const txCount = txs.length;

        // Update incremental metrics (txCount)
        this.updateIncrementalMetric(TIME_INTERVAL_HOUR, blockTimestamp, METRIC_txCount, txCount);
        this.updateIncrementalMetric(TIME_INTERVAL_DAY, blockTimestamp, METRIC_txCount, txCount);
        this.updateIncrementalMetric(TIME_INTERVAL_WEEK, blockTimestamp, METRIC_txCount, txCount);
        this.updateIncrementalMetric(TIME_INTERVAL_MONTH, blockTimestamp, METRIC_txCount, txCount);

        // Count contract deployments in this block
        const contractCount = this.countContractDeployments(txs, traces);
        this.cumulativeContractCount += contractCount;

        // Update cumulative metrics (cumulativeContracts) - only day interval supported
        this.updateCumulativeMetric(TIME_INTERVAL_DAY, blockTimestamp, METRIC_cumulativeContracts, this.cumulativeContractCount);
    }

    private countContractDeployments(txs: LazyTx[], traces: LazyTraces | undefined): number {
        if (!traces) {
            // Fallback to current method when traces are unavailable
            return txs.filter(tx => tx.contractAddress).length;
        }

        // Count CREATE, CREATE2, and CREATE3 calls from traces
        let contractCount = 0;
        for (const trace of traces.traces) {
            contractCount += this.countCreateCallsInTrace(trace.result);
        }
        return contractCount;
    }

    private countCreateCallsInTrace(call: LazyTraceCall): number {
        let count = 0;

        // Check if this call is a contract creation (CREATE, CREATE2)
        if (call.type === 'CREATE' || call.type === 'CREATE2') {
            count = 1;
        }

        // Recursively check nested calls
        if (call.calls) {
            for (const nestedCall of call.calls) {
                count += this.countCreateCallsInTrace(nestedCall);
            }
        }

        return count;
    }

    private updateIncrementalMetric(timeInterval: number, timestamp: number, metric: number, increment: number): void {
        const normalizedTimestamp = normalizeTimestamp(timestamp, timeInterval);

        this.indexingDb.prepare(`
            INSERT INTO metrics (timeInterval, timestamp, metric, value) 
            VALUES (?, ?, ?, ?)
            ON CONFLICT(timeInterval, timestamp, metric) 
            DO UPDATE SET value = value + ?
        `).run(timeInterval, normalizedTimestamp, metric, increment, increment);
    }

    private updateCumulativeMetric(timeInterval: number, timestamp: number, metric: number, totalValue: number): void {
        const normalizedTimestamp = normalizeTimestamp(timestamp, timeInterval);

        this.indexingDb.prepare(`
            INSERT INTO metrics (timeInterval, timestamp, metric, value) 
            VALUES (?, ?, ?, ?)
            ON CONFLICT(timeInterval, timestamp, metric) 
            DO UPDATE SET value = ?
        `).run(timeInterval, normalizedTimestamp, metric, totalValue, totalValue);
    }

    registerRoutes(app: OpenAPIHono): void {
        // Create a separate route for each metric
        for (const [metricName, metricId] of Object.entries(METRICS)) {
            this.createMetricRoute(app, metricName, metricId);
        }
    }

    private createMetricRoute(app: OpenAPIHono, metricName: string, metricId: number): void {
        const route = createRoute({
            method: 'get',
            path: `/metrics/${metricName}`,
            request: {
                query: MetricQuerySchema,
            },
            responses: {
                200: {
                    content: {
                        'application/json': {
                            schema: MetricResponseSchema
                        }
                    },
                    description: `${metricName} metric data`
                },
                400: {
                    description: 'Bad request (invalid parameters)'
                }
            },
            tags: ['Metrics'],
            summary: `Get ${metricName} data`,
            description: `Retrieve ${metricName} blockchain metric with optional filtering and pagination`
        });

        app.openapi(route, (c) => {
            const {
                startTimestamp,
                endTimestamp,
                timeInterval = 'hour',
                pageSize = 100,
                pageToken
            } = c.req.valid('query');

            // Map time interval to constant
            const timeIntervalId = this.getTimeIntervalId(timeInterval);
            if (timeIntervalId === -1) {
                return c.json({ error: `Invalid timeInterval: ${timeInterval}` }, 400);
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
            const backfilledResults = this.backfillZeros(results, timeIntervalId, metricId, startTimestamp, endTimestamp);

            const response: any = {
                results: backfilledResults.slice(0, validPageSize),
                nextPageToken: hasNextPage && backfilledResults.length > 0
                    ? backfilledResults[Math.min(validPageSize - 1, backfilledResults.length - 1)]!.timestamp.toString()
                    : undefined
            };

            return c.json(response);
        });
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

    private backfillZeros(results: MetricResult[], timeInterval: number, metricId: number, startTimestamp?: number, endTimestamp?: number): MetricResult[] {
        if (results.length === 0) return results;

        const backfilled: MetricResult[] = [];
        const resultMap = new Map(results.map(r => [r.timestamp, r.value]));

        const oldest = results[results.length - 1]!.timestamp;
        const newest = results[0]!.timestamp;

        const start = startTimestamp ? Math.max(startTimestamp, oldest) : oldest;
        const end = endTimestamp ? Math.min(endTimestamp, newest) : newest;

        const isMetricCumulative = isCumulativeMetric(metricId);

        // For cumulative metrics, we need to initialize with the most recent actual value
        let lastKnownValue = 0;
        if (isMetricCumulative && results.length > 0) {
            // Find the most recent actual value (results are sorted desc by timestamp)
            lastKnownValue = results[0]!.value;
        }

        let current = newest;
        while (current >= start) {
            const value = resultMap.get(current);
            if (value !== undefined) {
                lastKnownValue = value;
                backfilled.push({
                    timestamp: current,
                    value: value
                });
            } else {
                // For cumulative metrics, use last known value; for incremental metrics, use 0
                backfilled.push({
                    timestamp: current,
                    value: isMetricCumulative ? lastKnownValue : 0
                });
            }
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
