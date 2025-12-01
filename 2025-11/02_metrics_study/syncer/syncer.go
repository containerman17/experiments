package syncer

import (
	"context"
	"log"
	"time"

	"metrics-syncer/clickhouse"
	"metrics-syncer/store"
)

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
