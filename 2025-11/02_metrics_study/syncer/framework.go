package syncer

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"log"
	"math/big"
	"time"

	"metrics-syncer/clickhouse"
	"metrics-syncer/store"
)

// Granularity represents time granularity
type Granularity string

const (
	Hour  Granularity = "hour"
	Day   Granularity = "day"
	Week  Granularity = "week"
	Month Granularity = "month"
)

var AllGranularities = []Granularity{Hour, Day, Week, Month}

// CumulativeGranularities - cumulative metrics skip hour (too expensive)
var CumulativeGranularities = []Granularity{Day, Week, Month}

// ValueMetric defines a metric that returns a single value per period (incremental)
type ValueMetric struct {
	Name       string // API name (camelCase)
	Query      string // ClickHouse query with placeholders
	Version    string // Optional version - if empty, uses hash of Query
	RollingAgg string // "sum", "max", "avg", "" = not in rolling windows
}

// CumulativeMetric defines a metric that requires full table scan (e.g., unique counts)
// These skip hourly granularity because they're expensive
type CumulativeMetric struct {
	Name    string // API name (camelCase), e.g., "cumulativeAddresses"
	Query   string // ClickHouse query - does full scan, returns only periods >= watermark
	Version string // Optional version - if empty, uses hash of Query
}

// getVersion returns explicit version or hash of query
func getVersion(version, query string) string {
	if version != "" {
		return version
	}
	h := sha256.Sum256([]byte(query))
	return hex.EncodeToString(h[:8]) // 16 char hex
}

// Syncer handles metric synchronization
type Syncer struct {
	ch                *clickhouse.Client
	store             *store.Store
	valueMetrics      []ValueMetric
	cumulativeMetrics []CumulativeMetric
}

func New(ch *clickhouse.Client, st *store.Store) *Syncer {
	return &Syncer{
		ch:    ch,
		store: st,
	}
}

func (s *Syncer) RegisterValueMetrics(metrics ...ValueMetric) {
	s.valueMetrics = append(s.valueMetrics, metrics...)
}

func (s *Syncer) RegisterCumulativeMetrics(metrics ...CumulativeMetric) {
	s.cumulativeMetrics = append(s.cumulativeMetrics, metrics...)
}

// Run starts the watermark-driven sync loop
func (s *Syncer) Run(ctx context.Context) {
	for {
		if err := s.syncOnce(ctx); err != nil {
			log.Printf("sync error: %v", err)
		}

		select {
		case <-ctx.Done():
			return
		case <-time.After(30 * time.Second):
		}
	}
}

func (s *Syncer) syncOnce(ctx context.Context) error {
	// Get all chain watermarks with block_time
	watermarks, err := s.ch.GetSyncWatermarks(ctx)
	if err != nil {
		return err
	}

	// Load chain states from SQLite
	chainStates := s.store.GetAllChainStates()

	// Track max remote time for total chain
	var maxRemoteTime time.Time
	anyChainSynced := false

	for _, wm := range watermarks {
		prevTs := chainStates[wm.ChainID]
		prev := time.Unix(prevTs, 0).UTC()
		now := wm.BlockTime

		// Track maximum for total
		if maxRemoteTime.IsZero() || now.After(maxRemoteTime) {
			maxRemoteTime = now
		}

		// Skip if no change (compare unix timestamps to avoid precision issues)
		if now.Unix() == prevTs {
			continue
		}

		// Determine which granularities need sync
		syncHour := prevTs == 0 || truncHour(now) != truncHour(prev)
		syncDay := prevTs == 0 || truncDay(now) != truncDay(prev)
		syncWeek := prevTs == 0 || truncWeek(now) != truncWeek(prev)
		syncMonth := prevTs == 0 || truncMonth(now) != truncMonth(prev)

		if syncHour || syncDay || syncWeek || syncMonth {
			anyChainSynced = true
			log.Printf("chain %s: block_time %s (prev: %s) -> hour:%v day:%v week:%v month:%v",
				chainStr(wm.ChainID), now.Format("2006-01-02 15:04"), prev.Format("2006-01-02 15:04"),
				syncHour, syncDay, syncWeek, syncMonth)
		}

		// Sync value metrics for triggered granularities
		for _, metric := range s.valueMetrics {
			if syncHour {
				s.syncValueMetric(ctx, wm.ChainID, metric, Hour, now)
			}
			if syncDay {
				s.syncValueMetric(ctx, wm.ChainID, metric, Day, now)
			}
			if syncWeek {
				s.syncValueMetric(ctx, wm.ChainID, metric, Week, now)
			}
			if syncMonth {
				s.syncValueMetric(ctx, wm.ChainID, metric, Month, now)
			}
		}

		// Sync cumulative metrics (skip hour - too expensive)
		for _, metric := range s.cumulativeMetrics {
			if syncDay {
				s.syncCumulativeMetric(ctx, wm.ChainID, metric, Day, now)
			}
			if syncWeek {
				s.syncCumulativeMetric(ctx, wm.ChainID, metric, Week, now)
			}
			if syncMonth {
				s.syncCumulativeMetric(ctx, wm.ChainID, metric, Month, now)
			}
		}

		// Persist chain state to SQLite
		s.store.SetChainState(wm.ChainID, now.Unix())
	}

	// Sync total if any chain was synced
	if anyChainSynced && !maxRemoteTime.IsZero() {
		s.syncTotal(ctx, maxRemoteTime)
	}

	return nil
}

// Truncate helpers - return unix timestamp for comparison (includes year)
func truncHour(t time.Time) int64  { return t.Truncate(time.Hour).Unix() }
func truncDay(t time.Time) int64   { return t.Truncate(24 * time.Hour).Unix() }
func truncWeek(t time.Time) int64  { return truncateToPeriod(t, Week).Unix() }
func truncMonth(t time.Time) int64 { return truncateToPeriod(t, Month).Unix() }

// TotalChainID is the pseudo-chain ID for aggregated metrics across all chains
const TotalChainID uint32 = 0xFFFFFFFF // -1 as uint32

// chainStr returns a readable string for chain ID (e.g., "total" or "43114")
func chainStr(chainID uint32) string {
	if chainID == TotalChainID {
		return "total"
	}
	return fmt.Sprintf("%d", chainID)
}

// syncTotal syncs the "total" pseudo-chain across all chains
func (s *Syncer) syncTotal(ctx context.Context, remoteTime time.Time) {
	// Sync value metrics
	for _, metric := range s.valueMetrics {
		for _, gran := range AllGranularities {
			if err := s.syncValueMetric(ctx, TotalChainID, metric, gran, remoteTime); err != nil {
				log.Printf("failed to sync %s/%s for total: %v", metric.Name, gran, err)
			}
		}
	}

	// Sync cumulative metrics
	for _, metric := range s.cumulativeMetrics {
		for _, gran := range CumulativeGranularities {
			if err := s.syncCumulativeMetric(ctx, TotalChainID, metric, gran, remoteTime); err != nil {
				log.Printf("failed to sync %s/%s for total: %v", metric.Name, gran, err)
			}
		}
	}
}

func (s *Syncer) syncValueMetric(ctx context.Context, chainID uint32, metric ValueMetric, gran Granularity, remoteTime time.Time) error {
	version := getVersion(metric.Version, metric.Query)

	// Get local watermark and check version
	localWm, hasLocal := s.store.GetWatermark(chainID, metric.Name, string(gran))
	if hasLocal && localWm.Version != version {
		log.Printf("version changed for %s/%s chain %s: %s -> %s, resetting", metric.Name, gran, chainStr(chainID), localWm.Version, version)
		if err := s.store.DeleteMetricData(chainID, metric.Name, string(gran)); err != nil {
			return err
		}
		hasLocal = false
	}

	var startTime time.Time
	if hasLocal {
		startTime = time.Unix(localWm.LastTs, 0).UTC()
	} else {
		// New chain - get min block time
		minTime, err := s.ch.GetMinBlockTime(ctx, chainID)
		if err != nil {
			return err
		}
		startTime = truncateToPeriod(minTime, gran)
	}

	// Calculate complete periods
	periods := completePeriods(startTime, remoteTime, gran)
	if len(periods) == 0 {
		return nil
	}

	// Query all periods at once
	periodStart := periods[0].Start
	periodEnd := periods[len(periods)-1].End

	chStart := time.Now()
	rows, err := s.ch.Query(ctx, metric.Query, chainID, periodStart, periodEnd, string(gran))
	if err != nil {
		return err
	}
	defer rows.Close()

	// Collect results
	results := make(map[int64]*big.Int)
	for rows.Next() {
		var period time.Time
		var value big.Int
		if err := rows.Scan(&period, &value); err != nil {
			return err
		}
		results[period.Unix()] = new(big.Int).Set(&value)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	chDuration := time.Since(chStart)

	// Store in batch
	sqliteStart := time.Now()
	batch, err := s.store.NewBatch()
	if err != nil {
		return err
	}

	for _, p := range periods {
		ts := p.Start.Unix()
		value := results[ts]
		if value == nil {
			value = big.NewInt(0)
		}
		if err := batch.SetMetric(chainID, metric.Name, string(gran), ts, value.String()); err != nil {
			batch.Rollback()
			return err
		}
	}

	// Update watermark with version
	if err := batch.SetWatermark(chainID, metric.Name, string(gran), periods[len(periods)-1].End.Unix(), version); err != nil {
		batch.Rollback()
		return err
	}

	if err := batch.Commit(); err != nil {
		return err
	}
	sqliteDuration := time.Since(sqliteStart)

	log.Printf("synced %s/%s chain %s: %d periods until %s (ch: %dms, sqlite: %dms)",
		metric.Name, gran, chainStr(chainID), len(periods),
		periods[len(periods)-1].End.Format("2006-01-02 15:04"),
		chDuration.Milliseconds(), sqliteDuration.Milliseconds())

	// Invalidate total watermark if this chain synced new data
	if chainID != TotalChainID {
		s.invalidateTotalWatermark(metric.Name, string(gran), periods[0].Start.Unix(), version)
	}

	return nil
}

// invalidateTotalWatermark pushes total's watermark back if a chain synced older data
func (s *Syncer) invalidateTotalWatermark(metric, granularity string, oldestPeriodTs int64, version string) {
	totalWm, hasWm := s.store.GetWatermark(TotalChainID, metric, granularity)
	if !hasWm || oldestPeriodTs < totalWm.LastTs {
		// Push total watermark back to include this new data
		s.store.SetWatermark(TotalChainID, metric, granularity, oldestPeriodTs, version)
		log.Printf("invalidated total watermark for %s/%s to %s",
			metric, granularity, time.Unix(oldestPeriodTs, 0).Format("2006-01-02 15:04"))
	}
}

func (s *Syncer) syncCumulativeMetric(ctx context.Context, chainID uint32, metric CumulativeMetric, gran Granularity, remoteTime time.Time) error {
	version := getVersion(metric.Version, metric.Query)

	// Get local watermark and check version
	localWm, hasLocal := s.store.GetWatermark(chainID, metric.Name, string(gran))
	if hasLocal && localWm.Version != version {
		log.Printf("version changed for %s/%s chain %s: %s -> %s, resetting", metric.Name, gran, chainStr(chainID), localWm.Version, version)
		if err := s.store.DeleteMetricData(chainID, metric.Name, string(gran)); err != nil {
			return err
		}
		hasLocal = false
	}

	var startTime time.Time
	if hasLocal {
		startTime = time.Unix(localWm.LastTs, 0).UTC()
	} else {
		// New chain - get min block time
		minTime, err := s.ch.GetMinBlockTime(ctx, chainID)
		if err != nil {
			return err
		}
		startTime = truncateToPeriod(minTime, gran)
	}

	// Calculate complete periods
	periods := completePeriods(startTime, remoteTime, gran)
	if len(periods) == 0 {
		return nil
	}

	// Query - cumulative queries do full scan but only return periods >= watermark
	periodStart := periods[0].Start
	periodEnd := periods[len(periods)-1].End

	chStart := time.Now()
	rows, err := s.ch.Query(ctx, metric.Query, chainID, periodStart, periodEnd, string(gran))
	if err != nil {
		return err
	}
	defer rows.Close()

	// Collect results
	results := make(map[int64]*big.Int)
	for rows.Next() {
		var period time.Time
		var value big.Int
		if err := rows.Scan(&period, &value); err != nil {
			return err
		}
		results[period.Unix()] = new(big.Int).Set(&value)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	chDuration := time.Since(chStart)

	if len(results) == 0 {
		// No data yet, still update watermark
		s.store.SetWatermark(chainID, metric.Name, string(gran), periods[len(periods)-1].End.Unix(), version)
		return nil
	}

	// Store in batch
	sqliteStart := time.Now()
	batch, err := s.store.NewBatch()
	if err != nil {
		return err
	}

	for ts, value := range results {
		if err := batch.SetMetric(chainID, metric.Name, string(gran), ts, value.String()); err != nil {
			batch.Rollback()
			return err
		}
	}

	// Update watermark with version
	if err := batch.SetWatermark(chainID, metric.Name, string(gran), periods[len(periods)-1].End.Unix(), version); err != nil {
		batch.Rollback()
		return err
	}

	if err := batch.Commit(); err != nil {
		return err
	}
	sqliteDuration := time.Since(sqliteStart)

	log.Printf("synced %s/%s chain %s: %d periods until %s (ch: %dms, sqlite: %dms)",
		metric.Name, gran, chainStr(chainID), len(results),
		periods[len(periods)-1].End.Format("2006-01-02 15:04"),
		chDuration.Milliseconds(), sqliteDuration.Milliseconds())

	// Invalidate total watermark if this chain synced new data
	if chainID != TotalChainID {
		s.invalidateTotalWatermark(metric.Name, string(gran), periods[0].Start.Unix(), version)
	}

	return nil
}

// Period represents a time period
type Period struct {
	Start time.Time
	End   time.Time
}

// completePeriods returns periods that are fully complete (next period has started)
func completePeriods(start, remoteTime time.Time, gran Granularity) []Period {
	// Truncate remote time to period start - this is the "current" incomplete period
	currentPeriodStart := truncateToPeriod(remoteTime, gran)

	// We only index up to (but not including) the current period
	end := currentPeriodStart

	if !start.Before(end) {
		return nil
	}

	var periods []Period
	current := truncateToPeriod(start, gran)
	for current.Before(end) {
		next := nextPeriod(current, gran)
		periods = append(periods, Period{Start: current, End: next})
		current = next
	}

	return periods
}

func truncateToPeriod(t time.Time, gran Granularity) time.Time {
	t = t.UTC()
	switch gran {
	case Hour:
		return time.Date(t.Year(), t.Month(), t.Day(), t.Hour(), 0, 0, 0, time.UTC)
	case Day:
		return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
	case Week:
		// Week starts on Monday
		weekday := int(t.Weekday())
		if weekday == 0 {
			weekday = 7
		}
		return time.Date(t.Year(), t.Month(), t.Day()-weekday+1, 0, 0, 0, 0, time.UTC)
	case Month:
		return time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, time.UTC)
	default:
		return t
	}
}

func nextPeriod(t time.Time, gran Granularity) time.Time {
	switch gran {
	case Hour:
		return t.Add(time.Hour)
	case Day:
		return t.AddDate(0, 0, 1)
	case Week:
		return t.AddDate(0, 0, 7)
	case Month:
		return t.AddDate(0, 1, 0)
	default:
		return t
	}
}

func scanValue(rows *sql.Rows) (time.Time, *big.Int, error) {
	var period time.Time
	var value big.Int
	if err := rows.Scan(&period, &value); err != nil {
		return time.Time{}, nil, err
	}
	return period, &value, nil
}
