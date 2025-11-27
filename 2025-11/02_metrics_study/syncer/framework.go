package syncer

import (
	"context"
	"database/sql"
	"log"
	"math/big"
	"sort"
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

// MaxPeriodsPerSync limits how many periods to process in one sync iteration
const MaxPeriodsPerSync = 5000

// maxPeriods returns period limit based on granularity (coarser = fewer periods)
func maxPeriods(gran Granularity, isEntity bool) int {
	if isEntity {
		// Entity metrics do heavy GROUP BY, need smaller batches
		switch gran {
		case Hour:
			return 24 // 1 day
		case Day:
			return 7 // 1 week
		case Week:
			return 2 // 2 weeks
		case Month:
			return 1 // 1 month
		}
	}
	return MaxPeriodsPerSync
}

// ValueMetric defines a metric that returns a single value per period
type ValueMetric struct {
	Name  string // API name (camelCase)
	Query string // ClickHouse query with placeholders
}

// EntityMetric defines a metric that tracks unique entities
type EntityMetric struct {
	Name           string // Internal name for entity storage
	CumulativeName string // API name for cumulative metric (camelCase)
	Query          string // ClickHouse query returning 'entity' column
}

// Syncer handles metric synchronization
type Syncer struct {
	ch            *clickhouse.Client
	store         *store.Store
	valueMetrics  []ValueMetric
	entityMetrics []EntityMetric
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

func (s *Syncer) RegisterEntityMetrics(metrics ...EntityMetric) {
	s.entityMetrics = append(s.entityMetrics, metrics...)
}

// Run starts the sync loop
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
	// Get all chain watermarks
	watermarks, err := s.ch.GetSyncWatermarks(ctx)
	if err != nil {
		return err
	}

	log.Printf("syncing %d chains", len(watermarks))

	for _, wm := range watermarks {
		// Get block_time for this chain's watermark
		remoteTime, err := s.ch.GetBlockTime(ctx, wm.ChainID, wm.BlockNumber)
		if err != nil {
			log.Printf("failed to get block time for chain %d: %v", wm.ChainID, err)
			continue
		}

		// Sync all metrics for this chain
		for _, metric := range s.valueMetrics {
			for _, gran := range AllGranularities {
				if err := s.syncValueMetric(ctx, wm.ChainID, metric, gran, remoteTime); err != nil {
					log.Printf("failed to sync %s/%s for chain %d: %v", metric.Name, gran, wm.ChainID, err)
				}
			}
		}

		for _, metric := range s.entityMetrics {
			for _, gran := range AllGranularities {
				if err := s.syncEntityMetric(ctx, wm.ChainID, metric, gran, remoteTime); err != nil {
					log.Printf("failed to sync %s/%s for chain %d: %v", metric.Name, gran, wm.ChainID, err)
				}
			}
		}
	}

	return nil
}

func (s *Syncer) syncValueMetric(ctx context.Context, chainID uint32, metric ValueMetric, gran Granularity, remoteTime time.Time) error {
	// Get local watermark
	localWatermark, hasLocal := s.store.GetWatermark(chainID, metric.Name, string(gran))

	var startTime time.Time
	if hasLocal {
		startTime = time.Unix(localWatermark, 0).UTC()
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

	// Limit periods per sync to avoid long-running queries
	limit := maxPeriods(gran, false)
	if len(periods) > limit {
		periods = periods[:limit]
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
	pebbleStart := time.Now()
	batch := s.store.NewBatch()
	defer batch.Close()

	// Get previous cumulative value
	_, prevCumulative, hasPrev := s.store.GetLatestMetric(chainID, "cumulative"+capitalizeFirst(metric.Name), string(gran))
	if !hasPrev {
		prevCumulative = big.NewInt(0)
	}

	cumulative := new(big.Int).Set(prevCumulative)
	for _, p := range periods {
		ts := p.Start.Unix()
		value := results[ts]
		if value == nil {
			value = big.NewInt(0)
		}

		// Store regular metric
		batch.SetMetric(chainID, metric.Name, string(gran), ts, value)

		// Store cumulative
		cumulative.Add(cumulative, value)
		batch.SetMetric(chainID, "cumulative"+capitalizeFirst(metric.Name), string(gran), ts, new(big.Int).Set(cumulative))
	}

	// Update watermark
	batch.SetWatermark(chainID, metric.Name, string(gran), periods[len(periods)-1].End.Unix())

	if err := batch.Commit(); err != nil {
		return err
	}
	pebbleDuration := time.Since(pebbleStart)

	log.Printf("synced %s/%s chain %d: %d periods until %s (ch: %dms, pebble: %dms)",
		metric.Name, gran, chainID, len(periods),
		periods[len(periods)-1].End.Format("2006-01-02 15:04"),
		chDuration.Milliseconds(), pebbleDuration.Milliseconds())
	return nil
}

func (s *Syncer) syncEntityMetric(ctx context.Context, chainID uint32, metric EntityMetric, gran Granularity, remoteTime time.Time) error {
	// Get local watermark
	localWatermark, hasLocal := s.store.GetWatermark(chainID, metric.Name, string(gran))

	var startTime time.Time
	if hasLocal {
		startTime = time.Unix(localWatermark, 0).UTC()
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

	// Limit periods per sync - entity metrics need smaller batches
	limit := maxPeriods(gran, true)
	if len(periods) > limit {
		periods = periods[:limit]
	}

	// ONE query for entire range - returns (entity, first_seen_period)
	periodStart := periods[0].Start
	periodEnd := periods[len(periods)-1].End

	log.Printf("querying %s/%s chain %d: %s to %s...", metric.Name, gran, chainID,
		periodStart.Format("2006-01-02"), periodEnd.Format("2006-01-02"))

	// Single batch for everything
	batch := s.store.NewBatch()
	defer batch.Close()

	chStart := time.Now()
	rows, err := s.ch.Query(ctx, metric.Query, chainID, periodStart, periodEnd, string(gran))
	if err != nil {
		return err
	}
	defer rows.Close()

	// Track new entity counts in memory
	newCounts := make(map[int64]int64)
	entityCount := 0

	for rows.Next() {
		var entity []byte
		var firstSeenPeriod time.Time
		if err := scanEntityWithPeriod(rows, &entity, &firstSeenPeriod); err != nil {
			return err
		}
		// SetEntityIfNew checks main DB, writes to batch, returns true if new
		if batch.SetEntityIfNew(chainID, metric.Name, entity, firstSeenPeriod.Unix()) {
			newCounts[firstSeenPeriod.Unix()]++
		}
		entityCount++
		if entityCount%100000 == 0 {
			log.Printf("  ...processed %d entities so far", entityCount)
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	chDuration := time.Since(chStart)
	log.Printf("  query done: %d entities in %dms", entityCount, chDuration.Milliseconds())

	// Merge with existing counts from DB
	pebbleStart := time.Now()
	counts := s.store.CountEntitiesByPeriod(chainID, metric.Name)
	for ts, cnt := range newCounts {
		if counts[ts] == nil {
			counts[ts] = big.NewInt(cnt)
		} else {
			counts[ts].Add(counts[ts], big.NewInt(cnt))
		}
	}

	// Sort periods and compute cumulative
	var sortedPeriods []int64
	for ts := range counts {
		sortedPeriods = append(sortedPeriods, ts)
	}
	sort.Slice(sortedPeriods, func(i, j int) bool { return sortedPeriods[i] < sortedPeriods[j] })

	cumulative := big.NewInt(0)
	for _, ts := range sortedPeriods {
		cumulative.Add(cumulative, counts[ts])
		batch.SetMetric(chainID, metric.CumulativeName, string(gran), ts, new(big.Int).Set(cumulative))
	}

	// Update watermark
	batch.SetWatermark(chainID, metric.Name, string(gran), periods[len(periods)-1].End.Unix())

	if err := batch.Commit(); err != nil {
		return err
	}
	pebbleDuration := time.Since(pebbleStart)

	log.Printf("synced %s/%s chain %d: %d periods until %s, %d entities (ch: %dms, pebble: %dms)",
		metric.Name, gran, chainID, len(periods),
		periods[len(periods)-1].End.Format("2006-01-02 15:04"),
		entityCount, chDuration.Milliseconds(), pebbleDuration.Milliseconds())
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

func capitalizeFirst(s string) string {
	if len(s) == 0 {
		return s
	}
	return string(s[0]-32) + s[1:]
}

func scanEntityWithPeriod(rows *sql.Rows, entity *[]byte, period *time.Time) error {
	var b []byte
	var p time.Time
	if err := rows.Scan(&b, &p); err != nil {
		return err
	}
	*entity = b
	*period = p
	return nil
}
