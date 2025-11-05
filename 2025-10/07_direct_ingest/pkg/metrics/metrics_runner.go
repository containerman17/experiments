package metrics

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
)

// MetricsRunner processes blockchain metrics based on completed time periods.
// It ensures metrics are only calculated for periods where we have seen at least
// one block from the subsequent period, guaranteeing data completeness.
type MetricsRunner struct {
	conn             driver.Conn
	chainStates      map[uint32]*ChainState
	metrics          []MetricDefinition
	processorRunning sync.Once
	mu               sync.RWMutex
	sqlDir           string
}

// New creates a new MetricsRunner instance
func New(conn driver.Conn, sqlDir string) (*MetricsRunner, error) {
	return NewMetricsRunner(conn, sqlDir)
}

// NewMetricsRunner creates a new metrics runner
func NewMetricsRunner(conn driver.Conn, sqlDir string) (*MetricsRunner, error) {
	metrics, err := loadMetrics(sqlDir)
	if err != nil {
		panic(fmt.Sprintf("Fatal: failed to load metrics: %v", err))
	}

	runner := &MetricsRunner{
		conn:        conn,
		chainStates: make(map[uint32]*ChainState),
		metrics:     metrics,
		sqlDir:      sqlDir,
	}

	// Initialize tables
	if err := runner.initializeTables(); err != nil {
		panic(fmt.Sprintf("Fatal: failed to initialize tables: %v", err))
	}

	return runner, nil
}

// OnBlock updates the latest block information and ensures the processor is running
func (r *MetricsRunner) OnBlock(blockTimestamp uint64, chainId uint32) error {
	blockTime := time.Unix(int64(blockTimestamp), 0).UTC()

	// Update chain state
	r.mu.Lock()
	if r.chainStates[chainId] == nil {
		r.chainStates[chainId] = NewChainState()
		// Bootstrap last processed periods from database
		r.bootstrapChainState(chainId)
	}
	r.chainStates[chainId].UpdateLatestBlock(blockTime, 0) // block number not used in metrics
	r.mu.Unlock()

	// Ensure processor is running (happens once)
	r.processorRunning.Do(func() {
		go r.processLoop()
	})

	return nil
}

// processLoop continuously checks for completed periods and processes metrics
func (r *MetricsRunner) processLoop() {
	for {
		r.processAllCompletedPeriods()
		time.Sleep(1 * time.Second)
	}
}

// processAllCompletedPeriods checks all chains and metrics for completed periods
func (r *MetricsRunner) processAllCompletedPeriods() {
	r.mu.RLock()
	chains := make([]uint32, 0, len(r.chainStates))
	for chainId := range r.chainStates {
		chains = append(chains, chainId)
	}
	r.mu.RUnlock()

	for _, chainId := range chains {
		for _, metric := range r.metrics {
			for _, granularity := range metric.Granularities {
				r.processMetricForChain(chainId, metric, granularity)
			}
		}
	}
}

// processMetricForChain processes a specific metric/granularity for a chain
func (r *MetricsRunner) processMetricForChain(chainId uint32, metric MetricDefinition, granularity string) {
	r.mu.RLock()
	state := r.chainStates[chainId]
	r.mu.RUnlock()

	if state == nil {
		return
	}

	lastProcessed := state.GetLastProcessed(metric.Name, granularity)
	latestBlockTime := state.GetLatestBlockTime()

	if latestBlockTime.IsZero() {
		return // No blocks yet
	}

	// Get all unprocessed complete periods
	unprocessedPeriods := getUnprocessedPeriods(lastProcessed, latestBlockTime, granularity)
	if len(unprocessedPeriods) == 0 {
		return // Nothing to process
	}

	// Execute metric in batch for all unprocessed periods
	firstPeriod := unprocessedPeriods[0]
	lastPeriod := unprocessedPeriods[len(unprocessedPeriods)-1]

	if err := r.executeMetric(chainId, metric, granularity, firstPeriod, lastPeriod); err != nil {
		panic(fmt.Sprintf("Fatal: failed to execute metric %s for chain %d: %v", metric.Name, chainId, err))
	}

	// Update last processed
	state.SetLastProcessed(metric.Name, granularity, lastPeriod)
}

// executeMetric runs a metric query with the given parameters
func (r *MetricsRunner) executeMetric(chainId uint32, metric MetricDefinition, granularity string, firstPeriod, lastPeriod time.Time) error {
	ctx := context.Background()

	// Prepare SQL by replacing placeholders
	sql := metric.SQLTemplate
	sql = strings.ReplaceAll(sql, "{chain_id:UInt32}", fmt.Sprintf("%d", chainId))

	// Replace table names (use lowercase for table suffixes)
	sql = strings.ReplaceAll(sql, "_{granularity}", fmt.Sprintf("_%s", strings.ToLower(granularity)))

	// Replace function names (keep capitalized for ClickHouse functions)
	sql = strings.ReplaceAll(sql, "toStartOf{granularity}", fmt.Sprintf("toStartOf%s", granularity))

	// Replace any remaining {granularity} placeholders (shouldn't be any, but just in case)
	sql = strings.ReplaceAll(sql, "{granularity}", strings.ToLower(granularity))

	// Replace period placeholders
	sql = strings.ReplaceAll(sql, "{first_period:DateTime}", fmt.Sprintf("'%s'", formatPeriodForSQL(firstPeriod, granularity)))
	sql = strings.ReplaceAll(sql, "{last_period:DateTime}", fmt.Sprintf("'%s'", formatPeriodForSQL(lastPeriod, granularity)))
	// For Date columns (used in some cumulative metrics)
	sql = strings.ReplaceAll(sql, "{first_period:Date}", fmt.Sprintf("'%s'", firstPeriod.Format("2006-01-02")))
	sql = strings.ReplaceAll(sql, "{last_period:Date}", fmt.Sprintf("'%s'", lastPeriod.Format("2006-01-02")))

	// Replace period_seconds placeholder for metrics that need it
	sql = strings.ReplaceAll(sql, "{period_seconds:UInt64}", fmt.Sprintf("%d", getSecondsInPeriod(granularity)))

	// Execute the query
	if err := r.conn.Exec(ctx, sql); err != nil {
		return fmt.Errorf("query execution failed: %w", err)
	}

	return nil
}

// initializeTables creates metric tables if they don't exist
func (r *MetricsRunner) initializeTables() error {
	ctx := context.Background()

	for _, metric := range r.metrics {
		if metric.TableCreation == "" {
			continue // Some metrics use existing tables
		}

		// For metrics with multiple granularities, create table for each
		if len(metric.Granularities) > 0 && strings.Contains(metric.TableCreation, "{granularity}") {
			for _, granularity := range metric.Granularities {
				sql := strings.ReplaceAll(metric.TableCreation, "{granularity}", strings.ToLower(granularity))
				if err := r.conn.Exec(ctx, sql); err != nil {
					return fmt.Errorf("failed to create table for %s_%s: %w", metric.Name, granularity, err)
				}
			}
		} else {
			// Single table without granularity placeholder
			if err := r.conn.Exec(ctx, metric.TableCreation); err != nil {
				return fmt.Errorf("failed to create table for %s: %w", metric.Name, err)
			}
		}
	}

	return nil
}

// bootstrapChainState loads the last processed periods from database
func (r *MetricsRunner) bootstrapChainState(chainId uint32) {
	ctx := context.Background()
	state := r.chainStates[chainId]

	for _, metric := range r.metrics {
		for _, granularity := range metric.Granularities {
			tableName := metric.getTableName(granularity)
			if tableName == "" {
				continue
			}

			// Query max period for this chain
			query := fmt.Sprintf("SELECT max(period) FROM %s WHERE chain_id = ?", tableName)
			row := r.conn.QueryRow(ctx, query, chainId)

			var maxPeriod time.Time
			if err := row.Scan(&maxPeriod); err == nil && !maxPeriod.IsZero() {
				state.SetLastProcessed(metric.Name, granularity, maxPeriod)
			}
		}
	}
}
