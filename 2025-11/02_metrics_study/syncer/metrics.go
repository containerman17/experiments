package syncer

// All metric definitions
// Note: All value columns are cast to UInt256 for big.Int scanning

// ========== VALUE METRICS (incremental, all granularities) ==========

var TxCount = ValueMetric{
	Name:       "txCount",
	RollingAgg: "sum",
	Query: `
		SELECT
			toStartOf{granularityCamelCase}(block_time) as period,
			toUInt256(count(*)) as value
		FROM raw_txs
		WHERE {chain_filter}
		  AND block_time >= {period_start}
		  AND block_time < {period_end}
		GROUP BY period
		ORDER BY period 
	`,
}

var GasUsed = ValueMetric{
	Name:       "gasUsed",
	RollingAgg: "sum",
	Query: `
		SELECT
			toStartOf{granularityCamelCase}(block_time) as period,
			toUInt256(sum(gas_used)) as value
		FROM raw_txs
		WHERE {chain_filter}
		  AND block_time >= {period_start}
		  AND block_time < {period_end}
		GROUP BY period
		ORDER BY period
	`,
}

var FeesPaid = ValueMetric{
	Name:       "feesPaid",
	RollingAgg: "sum",
	Query: `
		SELECT
			toStartOf{granularityCamelCase}(block_time) as period,
			toUInt256(sum(gas_used * gas_price)) as value
		FROM raw_txs
		WHERE {chain_filter}
		  AND block_time >= {period_start}
		  AND block_time < {period_end}
		GROUP BY period
		ORDER BY period
	`,
}

var AvgTps = ValueMetric{
	Name:       "avgTps",
	RollingAgg: "avg",
	Query: `
		WITH period_data AS (
			SELECT
				toStartOf{granularityCamelCase}(block_time) as period,
				count(*) as tx_count
			FROM raw_txs
			WHERE {chain_filter}
			  AND block_time >= {period_start}
			  AND block_time < {period_end}
			GROUP BY period
		)
		SELECT
			period,
			toUInt256(tx_count / (toUnixTimestamp(period + INTERVAL 1 {granularity}) - toUnixTimestamp(period))) as value
		FROM period_data
		ORDER BY period
	`,
}

var MaxTps = ValueMetric{
	Name:       "maxTps",
	RollingAgg: "max",
	Query: `
		WITH txs_per_second AS (
			SELECT 
				toStartOf{granularityCamelCase}(block_time) as period,
				toStartOfSecond(block_time) as second,
				count(*) as tx_count
			FROM raw_txs
			WHERE {chain_filter}
			  AND block_time >= {period_start}
			  AND block_time < {period_end}
			GROUP BY period, second
		)
		SELECT
			period,
			toUInt256(max(tx_count)) as value
		FROM txs_per_second
		GROUP BY period
		ORDER BY period
	`,
}

var AvgGps = ValueMetric{
	Name:       "avgGps",
	RollingAgg: "avg",
	Query: `
		WITH period_data AS (
			SELECT
				toStartOf{granularityCamelCase}(block_time) as period,
				sum(gas_used) as gas_used
			FROM raw_txs
			WHERE {chain_filter}
			  AND block_time >= {period_start}
			  AND block_time < {period_end}
			GROUP BY period
		)
		SELECT
			period,
			toUInt256(gas_used / (toUnixTimestamp(period + INTERVAL 1 {granularity}) - toUnixTimestamp(period))) as value
		FROM period_data
		ORDER BY period
	`,
}

var MaxGps = ValueMetric{
	Name:       "maxGps",
	RollingAgg: "max",
	Query: `
		WITH gas_per_second AS (
			SELECT 
				toStartOf{granularityCamelCase}(block_time) as period,
				toStartOfSecond(block_time) as second,
				sum(gas_used) as gas_used
			FROM raw_blocks
			WHERE {chain_filter}
			  AND block_time >= {period_start}
			  AND block_time < {period_end}
			GROUP BY period, second
		)
		SELECT
			period,
			toUInt256(max(gas_used)) as value
		FROM gas_per_second
		GROUP BY period
		ORDER BY period
	`,
}

var AvgGasPrice = ValueMetric{
	Name:       "avgGasPrice",
	RollingAgg: "avg",
	Query: `
		SELECT
			toStartOf{granularityCamelCase}(block_time) as period,
			toUInt256(avg(gas_price)) as value
		FROM raw_txs
		WHERE {chain_filter}
		  AND block_time >= {period_start}
		  AND block_time < {period_end}
		GROUP BY period
		ORDER BY period
	`,
}

var MaxGasPrice = ValueMetric{
	Name:       "maxGasPrice",
	RollingAgg: "max",
	Query: `
		SELECT
			toStartOf{granularityCamelCase}(block_time) as period,
			toUInt256(max(gas_price)) as value
		FROM raw_txs
		WHERE {chain_filter}
		  AND block_time >= {period_start}
		  AND block_time < {period_end}
		GROUP BY period
		ORDER BY period
	`,
}

var Contracts = ValueMetric{
	Name:       "contracts",
	RollingAgg: "sum",
	Query: `
		SELECT
			toStartOf{granularityCamelCase}(block_time) as period,
			toUInt256(count(*)) as value
		FROM raw_traces
		WHERE {chain_filter}
		  AND block_time >= {period_start}
		  AND block_time < {period_end}
		  AND call_type IN ('CREATE', 'CREATE2', 'CREATE3')
		  AND tx_success = true
		GROUP BY period
		ORDER BY period
	`,
}

var ActiveAddresses = ValueMetric{
	Name:       "activeAddresses",
	RollingAgg: "sum",
	Query: `
		SELECT
			toStartOf{granularityCamelCase}(block_time) as period,
			toUInt256(uniq(address)) as value
		FROM (
			SELECT "from" as address, block_time
			FROM raw_traces
			WHERE {chain_filter}
			  AND block_time >= {period_start}
			  AND block_time < {period_end}
			  AND "from" != unhex('0000000000000000000000000000000000000000')
			
			UNION ALL
			
			SELECT "to" as address, block_time
			FROM raw_traces
			WHERE {chain_filter}
			  AND block_time >= {period_start}
			  AND block_time < {period_end}
			  AND "to" IS NOT NULL
			  AND "to" != unhex('0000000000000000000000000000000000000000')
		)
		GROUP BY period
		ORDER BY period
	`,
}

var ActiveSenders = ValueMetric{
	Name:       "activeSenders",
	RollingAgg: "sum",
	Query: `
		SELECT
			toStartOf{granularityCamelCase}(block_time) as period,
			toUInt256(uniq("from")) as value
		FROM raw_traces
		WHERE {chain_filter}
		  AND block_time >= {period_start}
		  AND block_time < {period_end}
		  AND "from" != unhex('0000000000000000000000000000000000000000')
		GROUP BY period
		ORDER BY period
	`,
}

var Deployers = ValueMetric{
	Name:       "deployers",
	RollingAgg: "sum",
	Query: `
		SELECT
			toStartOf{granularityCamelCase}(block_time) as period,
			toUInt256(uniq("from")) as value
		FROM raw_traces
		WHERE {chain_filter}
		  AND block_time >= {period_start}
		  AND block_time < {period_end}
		  AND call_type IN ('CREATE', 'CREATE2', 'CREATE3')
		  AND tx_success = true
		  AND "from" != unhex('0000000000000000000000000000000000000000')
		GROUP BY period
		ORDER BY period
	`,
}

var IcmSent = ValueMetric{
	Name: "icmSent",
	Query: `
		SELECT
			toStartOf{granularityCamelCase}(block_time) as period,
			toUInt256(count(*)) as value
		FROM raw_logs
		WHERE {chain_filter}
		  AND block_time >= {period_start}
		  AND block_time < {period_end}
		  AND topic0 = unhex('2a211ad4a59ab9d003852404f9c57c690704ee755f3c79d2c2812ad32da99df8')
		GROUP BY period
		ORDER BY period
	`,
}

var IcmReceived = ValueMetric{
	Name: "icmReceived",
	Query: `
		SELECT
			toStartOf{granularityCamelCase}(block_time) as period,
			toUInt256(count(*)) as value
		FROM raw_logs
		WHERE {chain_filter}
		  AND block_time >= {period_start}
		  AND block_time < {period_end}
		  AND topic0 = unhex('292ee90bbaf70b5d4936025e09d56ba08f3e421156b6a568cf3c2840d9343e34')
		GROUP BY period
		ORDER BY period
	`,
}

var IcmTotal = ValueMetric{
	Name: "icmTotal",
	Query: `
		SELECT
			toStartOf{granularityCamelCase}(block_time) as period,
			toUInt256(count(*)) as value
		FROM raw_logs
		WHERE {chain_filter}
		  AND block_time >= {period_start}
		  AND block_time < {period_end}
		  AND (
			topic0 = unhex('2a211ad4a59ab9d003852404f9c57c690704ee755f3c79d2c2812ad32da99df8')
			OR topic0 = unhex('292ee90bbaf70b5d4936025e09d56ba08f3e421156b6a568cf3c2840d9343e34')
		  )
		GROUP BY period
		ORDER BY period
	`,
}

// ========== CUMULATIVE METRICS (full scan, day/week/month only) ==========
// These query ClickHouse directly with baseline + window function
// Skip hourly granularity (too expensive ~55s per chain)

var CumulativeTxCount = CumulativeMetric{
	Name: "cumulativeTxCount",
	Query: `
		WITH
		txs_per_period AS (
			SELECT
				toStartOf{granularityCamelCase}(block_time) as period,
				count(*) as period_count
			FROM raw_txs
			WHERE {chain_filter}
			  AND block_time >= {period_start}
			  AND block_time < {period_end}
			GROUP BY period
		),
		baseline AS (
			SELECT count(*) as prev_cumulative
			FROM raw_txs
			WHERE {chain_filter}
			  AND block_time < {period_start}
		)
		SELECT
			period,
			toUInt256((SELECT prev_cumulative FROM baseline) + sum(period_count) OVER (ORDER BY period)) as value
		FROM txs_per_period
		ORDER BY period
	`,
}

var CumulativeContracts = CumulativeMetric{
	Name: "cumulativeContracts",
	Query: `
		WITH
		contracts_per_period AS (
			SELECT
				toStartOf{granularityCamelCase}(block_time) as period,
				count(*) as period_count
			FROM raw_traces
			WHERE {chain_filter}
			  AND block_time >= {period_start}
			  AND block_time < {period_end}
			  AND call_type IN ('CREATE', 'CREATE2', 'CREATE3')
			  AND tx_success = true
			GROUP BY period
		),
		baseline AS (
			SELECT count(*) as prev_cumulative
			FROM raw_traces
			WHERE {chain_filter}
			  AND block_time < {period_start}
			  AND call_type IN ('CREATE', 'CREATE2', 'CREATE3')
			  AND tx_success = true
		)
		SELECT
			period,
			toUInt256((SELECT prev_cumulative FROM baseline) + sum(period_count) OVER (ORDER BY period)) as value
		FROM contracts_per_period
		ORDER BY period
	`,
}

var CumulativeAddresses = CumulativeMetric{
	Name: "cumulativeAddresses",
	Query: `
		WITH
		first_appearances AS (
			SELECT 
				toStartOf{granularityCamelCase}(min(block_time)) as first_period,
				address
			FROM (
				SELECT "from" as address, block_time
				FROM raw_traces
				WHERE {chain_filter}
				  AND block_time >= {period_start}
				  AND block_time < {period_end}
				  AND "from" != unhex('0000000000000000000000000000000000000000')
				
				UNION ALL
				
				SELECT "to" as address, block_time
				FROM raw_traces
				WHERE {chain_filter}
				  AND block_time >= {period_start}
				  AND block_time < {period_end}
				  AND "to" IS NOT NULL
				  AND "to" != unhex('0000000000000000000000000000000000000000')
			)
			GROUP BY address
		),
		new_per_period AS (
			SELECT 
				first_period as period,
				uniq(address) as new_count
			FROM first_appearances
			GROUP BY period
		),
		baseline AS (
			SELECT countDistinct(address) as prev_cumulative
			FROM (
				SELECT "from" as address
				FROM raw_traces
				WHERE {chain_filter}
				  AND block_time < {period_start}
				  AND "from" != unhex('0000000000000000000000000000000000000000')
				
				UNION ALL
				
				SELECT "to" as address
				FROM raw_traces
				WHERE {chain_filter}
				  AND block_time < {period_start}
				  AND "to" IS NOT NULL
				  AND "to" != unhex('0000000000000000000000000000000000000000')
			)
		)
		SELECT
			period,
			toUInt256((SELECT prev_cumulative FROM baseline) + sum(new_count) OVER (ORDER BY period)) as value
		FROM new_per_period
		ORDER BY period
	`,
}

var CumulativeDeployers = CumulativeMetric{
	Name: "cumulativeDeployers",
	Query: `
		WITH
		first_deployments AS (
			SELECT 
				toStartOf{granularityCamelCase}(min(block_time)) as first_period,
				"from" as deployer
			FROM raw_traces
			WHERE {chain_filter}
			  AND block_time >= {period_start}
			  AND block_time < {period_end}
			  AND call_type IN ('CREATE', 'CREATE2', 'CREATE3')
			  AND tx_success = true
			  AND "from" != unhex('0000000000000000000000000000000000000000')
			GROUP BY deployer
		),
		new_per_period AS (
			SELECT 
				first_period as period,
				uniq(deployer) as new_count
			FROM first_deployments
			GROUP BY period
		),
		baseline AS (
			SELECT countDistinct("from") as prev_cumulative
			FROM raw_traces
			WHERE {chain_filter}
			  AND block_time < {period_start}
			  AND call_type IN ('CREATE', 'CREATE2', 'CREATE3')
			  AND tx_success = true
			  AND "from" != unhex('0000000000000000000000000000000000000000')
		)
		SELECT
			period,
			toUInt256((SELECT prev_cumulative FROM baseline) + sum(new_count) OVER (ORDER BY period)) as value
		FROM new_per_period
		ORDER BY period
	`,
}

// AllValueMetrics returns all value metrics
func AllValueMetrics() []ValueMetric {
	return []ValueMetric{
		TxCount,
		GasUsed,
		FeesPaid,
		AvgTps,
		MaxTps,
		AvgGps,
		MaxGps,
		AvgGasPrice,
		MaxGasPrice,
		Contracts,
		ActiveAddresses,
		ActiveSenders,
		Deployers,
		IcmSent,
		IcmReceived,
		IcmTotal,
	}
}

// AllCumulativeMetrics returns all cumulative metrics
func AllCumulativeMetrics() []CumulativeMetric {
	return []CumulativeMetric{
		CumulativeTxCount,
		CumulativeContracts,
		CumulativeAddresses,
		CumulativeDeployers,
	}
}
