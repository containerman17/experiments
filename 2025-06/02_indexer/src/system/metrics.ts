import SQLite3 from 'better-sqlite3'
import { z } from "@hono/zod-openapi"
import { cacheStatement } from '../lib/statementCache'

const createMetricsTableSQL = `
CREATE TABLE IF NOT EXISTS metrics (
    frequency TEXT NOT NULL,
    bucket INTEGER NOT NULL,
    dimension1 TEXT NOT NULL,
    dimension2 TEXT NOT NULL DEFAULT '',
    dimension3 TEXT NOT NULL DEFAULT '',
    dimension4 TEXT NOT NULL DEFAULT '',
    dimension5 TEXT NOT NULL DEFAULT '',
    value INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (frequency, bucket, dimension1, dimension2, dimension3, dimension4, dimension5)
) WITHOUT ROWID;
`

export function initialize(db: SQLite3.Database) {
    db.exec(createMetricsTableSQL)
}

export const Frequency = z.enum(['1h', '1d', '1w', '1m', 'total'])
const bucketSizes = {
    '1h': 3600,
    '1d': 86400,
    '1w': 604800,
    '1m': 2592000, // 30 days in seconds
    'total': 0 // Special case for total
}

export function getMetrics(db: SQLite3.Database, frequency: z.infer<typeof Frequency>, dimensions: string[], limit: number) {
    if (dimensions.length === 0 || dimensions.length > 5) {
        throw new Error('Must provide 1-5 dimensions')
    }

    // Pad dimensions array to 5 elements with empty strings
    const paddedDimensions = [...dimensions, '', '', '', '', ''].slice(0, 5)

    // Special handling for total frequency
    if (frequency === 'total') {
        const metrics = cacheStatement(db, `
            SELECT bucket, value 
            FROM metrics 
            WHERE frequency = ? 
            AND dimension1 = ? 
            AND dimension2 = ?
            AND dimension3 = ?
            AND dimension4 = ?
            AND dimension5 = ?
        `).all(frequency, ...paddedDimensions) as { bucket: number; value: number }[]

        return [{
            timestamp: 0,
            value: metrics.length > 0 ? metrics[0].value : 0
        }]
    }

    // Calculate time range based on frequency
    const now = Math.floor(Date.now() / 1000)
    const bucketSize = bucketSizes[frequency]

    // Align startTime to bucket boundary
    const unalignedStartTime = now - (bucketSize * limit)
    const startTime = Math.floor(unalignedStartTime / bucketSize) * bucketSize

    // Get existing metrics using cached statement
    const metrics = cacheStatement(db, `
        SELECT bucket, value 
        FROM metrics 
        WHERE frequency = ? 
        AND bucket >= ? 
        AND dimension1 = ? 
        AND dimension2 = ?
        AND dimension3 = ?
        AND dimension4 = ?
        AND dimension5 = ?
        ORDER BY bucket ASC
    `).all(frequency, startTime, ...paddedDimensions) as { bucket: number; value: number }[]

    // Create array of all timestamps
    const result = []
    for (let i = 0; i < limit; i++) {
        const timestamp = startTime + (i * bucketSize)
        const existingMetric = metrics.find(m => m.bucket === timestamp)
        result.push({
            timestamp,
            value: existingMetric ? existingMetric.value : 0
        })
    }

    return result
}

export function incrementMetric(db: SQLite3.Database, timestamp: number, dimensions: string[], value: number) {
    if (dimensions.length === 0 || dimensions.length > 5) {
        throw new Error('Must provide 1-5 dimensions')
    }

    // Pad dimensions array to 5 elements with empty strings
    const paddedDimensions = [...dimensions, '', '', '', '', ''].slice(0, 5)

    const frequencies: z.infer<typeof Frequency>[] = ['1h', '1d', '1w', '1m', 'total']
    const statement = cacheStatement(db, `
        INSERT INTO metrics (frequency, bucket, dimension1, dimension2, dimension3, dimension4, dimension5, value)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (frequency, bucket, dimension1, dimension2, dimension3, dimension4, dimension5)
        DO UPDATE SET value = value + excluded.value
    `)

    for (const frequency of frequencies) {
        const bucket = frequency === 'total' ? 0 : Math.floor(timestamp / bucketSizes[frequency]) * bucketSizes[frequency]
        statement.run(frequency, bucket, ...paddedDimensions, value)
    }
}

export function getUniqueDimensionValues(
    db: SQLite3.Database,
    dimensionIndex: number,
    filters: { [key: string]: string } = {}
): string[] {
    if (dimensionIndex < 1 || dimensionIndex > 5) {
        throw new Error('Dimension index must be between 1 and 5')
    }

    const dimensionColumn = `dimension${dimensionIndex}`
    let whereClause = `WHERE ${dimensionColumn} != ''`
    const params: string[] = []

    // Add filters for other dimensions
    for (const [key, value] of Object.entries(filters)) {
        whereClause += ` AND ${key} = ?`
        params.push(value)
    }

    const query = `
        SELECT DISTINCT ${dimensionColumn} as value 
        FROM metrics 
        ${whereClause}
    `

    const results = cacheStatement(db, query).all(...params) as { value: string }[]
    return results.map(r => r.value)
}
