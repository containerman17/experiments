package syncer

import (
	"context"
	"log"
	"math/big"
	"time"
)

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
		log.Printf("up to date %s/%s chain %s", metric.Name, gran, chainStr(chainID))
		return nil
	}

	// Query all periods at once
	periodStart := periods[0].Start
	periodEnd := periods[len(periods)-1].End

	log.Printf("syncing %s/%s chain %s: %s → %s (%d periods)",
		metric.Name, gran, chainStr(chainID),
		periodStart.Format("2006-01-02 15:04"), periodEnd.Format("2006-01-02 15:04"), len(periods))

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
		log.Printf("up to date %s/%s chain %s", metric.Name, gran, chainStr(chainID))
		return nil
	}

	// Query - cumulative queries do full scan but only return periods >= watermark
	periodStart := periods[0].Start
	periodEnd := periods[len(periods)-1].End

	log.Printf("syncing %s/%s chain %s: %s → %s (%d periods)",
		metric.Name, gran, chainStr(chainID),
		periodStart.Format("2006-01-02 15:04"), periodEnd.Format("2006-01-02 15:04"), len(periods))

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
