interface Config {
    readonly env: 'development' | 'production' | 'test'
    readonly isDevelopment: boolean
    readonly isProduction: boolean
    readonly isTest: boolean
    readonly port: number
    readonly logLevel: 'debug' | 'info' | 'warn' | 'error'
    readonly database: {
        readonly lmdb: {
            readonly path: string
            readonly maxDbs: number
            readonly mapSize: number
        }
        readonly sqlite: {
            readonly path: string
        }
    }
    readonly compression: {
        readonly enabled: boolean
        readonly level: number
    }
    readonly rpc: {
        readonly batchSize: number
        readonly timeout: number
        readonly retries: number
    }
}

const getEnv = (key: string, defaultValue?: string): string => {
    const value = process.env[key]
    if (value === undefined) {
        if (defaultValue === undefined) {
            throw new Error(`Environment variable ${key} is required`)
        }
        return defaultValue
    }
    return value
}

const getEnvNumber = (key: string, defaultValue?: number): number => {
    const value = process.env[key]
    if (value === undefined) {
        if (defaultValue === undefined) {
            throw new Error(`Environment variable ${key} is required`)
        }
        return defaultValue
    }
    const num = parseInt(value, 10)
    if (isNaN(num)) {
        throw new Error(`Environment variable ${key} must be a number`)
    }
    return num
}

const getEnvBoolean = (key: string, defaultValue?: boolean): boolean => {
    const value = process.env[key]
    if (value === undefined) {
        if (defaultValue === undefined) {
            throw new Error(`Environment variable ${key} is required`)
        }
        return defaultValue
    }
    return value.toLowerCase() === 'true'
}

const env = getEnv('NODE_ENV', 'development') as Config['env']

export const config: Config = {
    env,
    isDevelopment: env === 'development',
    isProduction: env === 'production',
    isTest: env === 'test',
    port: getEnvNumber('PORT', 3000),
    logLevel: getEnv('LOG_LEVEL', 'info') as Config['logLevel'],
    database: {
        lmdb: {
            path: getEnv('LMDB_PATH', './data/lmdb'),
            maxDbs: getEnvNumber('LMDB_MAX_DBS', 100),
            mapSize: getEnvNumber('LMDB_MAP_SIZE', 1024 * 1024 * 1024) // 1GB
        },
        sqlite: {
            path: getEnv('SQLITE_PATH', './data/sqlite.db')
        }
    },
    compression: {
        enabled: getEnvBoolean('COMPRESSION_ENABLED', true),
        level: getEnvNumber('COMPRESSION_LEVEL', 6)
    },
    rpc: {
        batchSize: getEnvNumber('RPC_BATCH_SIZE', 100),
        timeout: getEnvNumber('RPC_TIMEOUT', 30000),
        retries: getEnvNumber('RPC_RETRIES', 3)
    }
} as const

export default config
