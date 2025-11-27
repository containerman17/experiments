package syncer

// All metric definitions
// Note: All value columns are cast to UInt256 for big.Int scanning

var TxCount = ValueMetric{
	Name: "txCount",
	Query: `
		SELECT
			toStartOf{granularityCamelCase}(block_time) as period,
			toUInt256(count(*)) as value
		FROM raw_txs
		WHERE chain_id = {chain_id}
		  AND block_time >= {period_start}
		  AND block_time < {period_end}
		GROUP BY period
		ORDER BY period
	`,
}

var GasUsed = ValueMetric{
	Name: "gasUsed",
	Query: `
		SELECT
			toStartOf{granularityCamelCase}(block_time) as period,
			toUInt256(sum(gas_used)) as value
		FROM raw_txs
		WHERE chain_id = {chain_id}
		  AND block_time >= {period_start}
		  AND block_time < {period_end}
		GROUP BY period
		ORDER BY period
	`,
}

var FeesPaid = ValueMetric{
	Name: "feesPaid",
	Query: `
		SELECT
			toStartOf{granularityCamelCase}(block_time) as period,
			toUInt256(sum(gas_used * gas_price)) as value
		FROM raw_txs
		WHERE chain_id = {chain_id}
		  AND block_time >= {period_start}
		  AND block_time < {period_end}
		GROUP BY period
		ORDER BY period
	`,
}

var AvgTps = ValueMetric{
	Name: "avgTps",
	Query: `
		WITH period_data AS (
			SELECT
				toStartOf{granularityCamelCase}(block_time) as period,
				count(*) as tx_count
			FROM raw_txs
			WHERE chain_id = {chain_id}
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
	Name: "maxTps",
	Query: `
		WITH txs_per_second AS (
			SELECT 
				toStartOf{granularityCamelCase}(block_time) as period,
				toStartOfSecond(block_time) as second,
				count(*) as tx_count
			FROM raw_txs
			WHERE chain_id = {chain_id}
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
	Name: "avgGps",
	Query: `
		WITH period_data AS (
			SELECT
				toStartOf{granularityCamelCase}(block_time) as period,
				sum(gas_used) as gas_used
			FROM raw_txs
			WHERE chain_id = {chain_id}
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
	Name: "maxGps",
	Query: `
		WITH gas_per_second AS (
			SELECT 
				toStartOf{granularityCamelCase}(block_time) as period,
				toStartOfSecond(block_time) as second,
				sum(gas_used) as gas_used
			FROM raw_blocks
			WHERE chain_id = {chain_id}
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
	Name: "avgGasPrice",
	Query: `
		SELECT
			toStartOf{granularityCamelCase}(block_time) as period,
			toUInt256(avg(gas_price)) as value
		FROM raw_txs
		WHERE chain_id = {chain_id}
		  AND block_time >= {period_start}
		  AND block_time < {period_end}
		GROUP BY period
		ORDER BY period
	`,
}

var MaxGasPrice = ValueMetric{
	Name: "maxGasPrice",
	Query: `
		SELECT
			toStartOf{granularityCamelCase}(block_time) as period,
			toUInt256(max(gas_price)) as value
		FROM raw_txs
		WHERE chain_id = {chain_id}
		  AND block_time >= {period_start}
		  AND block_time < {period_end}
		GROUP BY period
		ORDER BY period
	`,
}

var Contracts = ValueMetric{
	Name: "contracts",
	Query: `
		SELECT
			toStartOf{granularityCamelCase}(block_time) as period,
			toUInt256(count(*)) as value
		FROM raw_traces
		WHERE chain_id = {chain_id}
		  AND block_time >= {period_start}
		  AND block_time < {period_end}
		  AND call_type IN ('CREATE', 'CREATE2', 'CREATE3')
		  AND tx_success = true
		GROUP BY period
		ORDER BY period
	`,
}

var ActiveAddresses = ValueMetric{
	Name: "activeAddresses",
	Query: `
		SELECT
			toStartOf{granularityCamelCase}(block_time) as period,
			toUInt256(uniq(address)) as value
		FROM (
			SELECT "from" as address, block_time
			FROM raw_traces
			WHERE chain_id = {chain_id}
			  AND block_time >= {period_start}
			  AND block_time < {period_end}
			  AND "from" != unhex('0000000000000000000000000000000000000000')
			
			UNION ALL
			
			SELECT "to" as address, block_time
			FROM raw_traces
			WHERE chain_id = {chain_id}
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
	Name: "activeSenders",
	Query: `
		SELECT
			toStartOf{granularityCamelCase}(block_time) as period,
			toUInt256(uniq("from")) as value
		FROM raw_traces
		WHERE chain_id = {chain_id}
		  AND block_time >= {period_start}
		  AND block_time < {period_end}
		  AND "from" != unhex('0000000000000000000000000000000000000000')
		GROUP BY period
		ORDER BY period
	`,
}

var Deployers = ValueMetric{
	Name: "deployers",
	Query: `
		SELECT
			toStartOf{granularityCamelCase}(block_time) as period,
			toUInt256(uniq("from")) as value
		FROM raw_traces
		WHERE chain_id = {chain_id}
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
		WHERE chain_id = {chain_id}
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
		WHERE chain_id = {chain_id}
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
		WHERE chain_id = {chain_id}
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

// Note: UsdcVolume is chain-specific (Avalanche C-Chain only)
var UsdcVolume = ValueMetric{
	Name: "usdcVolume",
	Query: `
		SELECT
			toStartOf{granularityCamelCase}(block_time) as period,
			toUInt256(sum(reinterpretAsUInt256(reverse(data))) / 1000000) as value
		FROM raw_logs
		WHERE chain_id = {chain_id}
		  AND address = unhex('b97ef9ef8734c71904d8002f8b6bc66dd9c48a6e')
		  AND topic0 = unhex('ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef')
		  AND block_time >= {period_start}
		  AND block_time < {period_end}
		GROUP BY period
		ORDER BY period
	`,
}

// Entity metrics - track unique entities for cumulative counting
// Queries return (entity, first_seen_period) - batched for efficiency

var Addresses = EntityMetric{
	Name:           "addresses",
	CumulativeName: "cumulativeAddresses",
	Query: `
		SELECT 
			address as entity,
			toStartOf{granularityCamelCase}(min(block_time)) as first_seen_period
		FROM (
			SELECT "from" as address, block_time
			FROM raw_traces
			WHERE chain_id = {chain_id}
			  AND block_time >= {period_start}
			  AND block_time < {period_end}
			  AND "from" != unhex('0000000000000000000000000000000000000000')
			
			UNION ALL
			
			SELECT "to" as address, block_time
			FROM raw_traces
			WHERE chain_id = {chain_id}
			  AND block_time >= {period_start}
			  AND block_time < {period_end}
			  AND "to" IS NOT NULL
			  AND "to" != unhex('0000000000000000000000000000000000000000')
		)
		GROUP BY address
	`,
}

var DeployersEntity = EntityMetric{
	Name:           "deployersEntity",
	CumulativeName: "cumulativeDeployers",
	Query: `
		SELECT 
			"from" as entity,
			toStartOf{granularityCamelCase}(min(block_time)) as first_seen_period
		FROM raw_traces
		WHERE chain_id = {chain_id}
		  AND block_time >= {period_start}
		  AND block_time < {period_end}
		  AND call_type IN ('CREATE', 'CREATE2', 'CREATE3')
		  AND tx_success = true
		  AND "from" != unhex('0000000000000000000000000000000000000000')
		GROUP BY "from"
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
		UsdcVolume,
	}
}

// AllEntityMetrics returns all entity metrics
func AllEntityMetrics() []EntityMetric {
	return []EntityMetric{
		Addresses,
		DeployersEntity,
	}
}
