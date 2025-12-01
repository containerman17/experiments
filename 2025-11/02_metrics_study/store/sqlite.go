package store

import (
	"database/sql"
	"log"
	"math/big"
	"os"
	"path/filepath"

	"github.com/mattn/go-sqlite3"
)

func init() {
	sql.Register("sqlite3_bigint", &sqlite3.SQLiteDriver{
		ConnectHook: func(conn *sqlite3.SQLiteConn) error {
			// RegisterAggregator needs constructor functions, not struct instances
			if err := conn.RegisterAggregator("sum_uint256", newSumUint256, true); err != nil {
				return err
			}
			if err := conn.RegisterAggregator("max_uint256", newMaxUint256, true); err != nil {
				return err
			}
			if err := conn.RegisterAggregator("avg_uint256", newAvgUint256, true); err != nil {
				return err
			}
			return nil
		},
	})
}

// --- sum_uint256 aggregate ---
type sumUint256Agg struct{ sum *big.Int }

func newSumUint256() *sumUint256Agg { return &sumUint256Agg{sum: new(big.Int)} }

func (a *sumUint256Agg) Step(val string) {
	if v, ok := new(big.Int).SetString(val, 10); ok {
		a.sum.Add(a.sum, v)
	}
}
func (a *sumUint256Agg) Done() string { return a.sum.String() }

// --- max_uint256 aggregate ---
type maxUint256Agg struct{ max *big.Int }

func newMaxUint256() *maxUint256Agg { return &maxUint256Agg{} }

func (a *maxUint256Agg) Step(val string) {
	v, ok := new(big.Int).SetString(val, 10)
	if !ok {
		return
	}
	if a.max == nil || v.Cmp(a.max) > 0 {
		a.max = v
	}
}
func (a *maxUint256Agg) Done() string {
	if a.max == nil {
		return "0"
	}
	return a.max.String()
}

// --- avg_uint256 aggregate ---
type avgUint256Agg struct {
	sum   *big.Int
	count int64
}

func newAvgUint256() *avgUint256Agg { return &avgUint256Agg{sum: new(big.Int)} }

func (a *avgUint256Agg) Step(val string) {
	if v, ok := new(big.Int).SetString(val, 10); ok {
		a.sum.Add(a.sum, v)
		a.count++
	}
}
func (a *avgUint256Agg) Done() string {
	if a.count == 0 {
		return "0"
	}
	result := new(big.Int).Div(a.sum, big.NewInt(a.count))
	return result.String()
}

type Store struct {
	db *sql.DB
}

func New(path string) *Store {
	// Create parent directory if it doesn't exist
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		log.Fatalf("failed to create parent directory for sqlite: %v", err)
	}

	db, err := sql.Open("sqlite3_bigint", path+"?_journal_mode=WAL&_synchronous=NORMAL")
	if err != nil {
		log.Fatalf("failed to open sqlite: %v", err)
	}

	// Create tables
	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS metrics (
			chain_id INTEGER NOT NULL,
			metric TEXT NOT NULL,
			granularity TEXT NOT NULL,
			ts INTEGER NOT NULL,
			value TEXT NOT NULL,
			PRIMARY KEY (chain_id, metric, granularity, ts)
		);

		CREATE TABLE IF NOT EXISTS watermarks (
			chain_id INTEGER NOT NULL,
			metric TEXT NOT NULL,
			granularity TEXT NOT NULL,
			last_ts INTEGER NOT NULL,
			version TEXT NOT NULL DEFAULT '',
			PRIMARY KEY (chain_id, metric, granularity)
		);

		CREATE TABLE IF NOT EXISTS chain_states (
			chain_id INTEGER PRIMARY KEY,
			last_block_time INTEGER NOT NULL
		);

		CREATE INDEX IF NOT EXISTS idx_metrics_lookup 
		ON metrics(chain_id, metric, granularity, ts DESC);
	`)
	if err != nil {
		log.Fatalf("failed to create tables: %v", err)
	}

	return &Store{db: db}
}

func (s *Store) Close() error {
	return s.db.Close()
}

// --- Chain States ---

// GetChainState returns the last block_time we processed for a chain (0 if not found)
func (s *Store) GetChainState(chainID uint32) int64 {
	var ts int64
	err := s.db.QueryRow(`SELECT last_block_time FROM chain_states WHERE chain_id = ?`, chainID).Scan(&ts)
	if err != nil {
		return 0
	}
	return ts
}

// SetChainState stores the last block_time we processed for a chain
func (s *Store) SetChainState(chainID uint32, blockTimeUnix int64) error {
	_, err := s.db.Exec(`INSERT OR REPLACE INTO chain_states (chain_id, last_block_time) VALUES (?, ?)`,
		chainID, blockTimeUnix)
	return err
}

// GetAllChainStates loads all chain states into a map
func (s *Store) GetAllChainStates() map[uint32]int64 {
	result := make(map[uint32]int64)
	rows, err := s.db.Query(`SELECT chain_id, last_block_time FROM chain_states`)
	if err != nil {
		return result
	}
	defer rows.Close()
	for rows.Next() {
		var chainID uint32
		var ts int64
		if err := rows.Scan(&chainID, &ts); err == nil {
			result[chainID] = ts
		}
	}
	return result
}

// --- Metrics ---

func (s *Store) SetMetric(chainID uint32, metric, granularity string, ts int64, value string) error {
	_, err := s.db.Exec(`
		INSERT OR REPLACE INTO metrics (chain_id, metric, granularity, ts, value)
		VALUES (?, ?, ?, ?, ?)
	`, chainID, metric, granularity, ts, value)
	return err
}

// MetricPoint represents a single metric data point
type MetricPoint struct {
	Timestamp int64
	Value     string
}

// ScanMetrics returns metrics in descending order (newest first) for pagination
func (s *Store) ScanMetrics(chainID uint32, metric, granularity string, startTs, endTs int64, limit int) ([]MetricPoint, int64) {
	rows, err := s.db.Query(`
		SELECT ts, value FROM metrics
		WHERE chain_id = ? AND metric = ? AND granularity = ?
		  AND ts >= ? AND ts <= ?
		ORDER BY ts DESC
		LIMIT ?
	`, chainID, metric, granularity, startTs, endTs, limit+1)
	if err != nil {
		log.Printf("scan metrics error: %v", err)
		return nil, -1
	}
	defer rows.Close()

	var points []MetricPoint
	for rows.Next() {
		var p MetricPoint
		if err := rows.Scan(&p.Timestamp, &p.Value); err != nil {
			log.Printf("scan row error: %v", err)
			continue
		}
		points = append(points, p)
	}

	// Check for next page
	var nextTs int64 = -1
	if len(points) > limit {
		nextTs = points[limit].Timestamp
		points = points[:limit]
	}

	return points, nextTs
}

// GetLatestMetric returns the most recent value for a metric
func (s *Store) GetLatestMetric(chainID uint32, metric, granularity string) (int64, string, bool) {
	var ts int64
	var value string
	err := s.db.QueryRow(`
		SELECT ts, value FROM metrics
		WHERE chain_id = ? AND metric = ? AND granularity = ?
		ORDER BY ts DESC LIMIT 1
	`, chainID, metric, granularity).Scan(&ts, &value)
	if err == sql.ErrNoRows {
		return 0, "", false
	}
	if err != nil {
		log.Printf("get latest metric error: %v", err)
		return 0, "", false
	}
	return ts, value, true
}

// AggregateMetric computes an aggregate over a time range using uint256 UDFs
// agg can be "sum", "max", "avg"
func (s *Store) AggregateMetric(chainID uint32, metric, agg string, startTs, endTs int64) (string, bool) {
	var aggFn string
	switch agg {
	case "sum":
		aggFn = "sum_uint256"
	case "max":
		aggFn = "max_uint256"
	case "avg":
		aggFn = "avg_uint256"
	default:
		return "0", false
	}

	// Use hourly data for rolling windows
	var value string
	err := s.db.QueryRow(`
		SELECT `+aggFn+`(value) FROM metrics
		WHERE chain_id = ? AND metric = ? AND granularity = 'hour'
		  AND ts >= ? AND ts < ?
	`, chainID, metric, startTs, endTs).Scan(&value)
	if err != nil {
		log.Printf("aggregate metric error: %v", err)
		return "0", false
	}
	return value, true
}

// GetMaxWatermark returns the max watermark timestamp for a metric (any granularity)
func (s *Store) GetMaxWatermark(chainID uint32, metric string) (int64, bool) {
	var ts int64
	err := s.db.QueryRow(`
		SELECT MAX(last_ts) FROM watermarks
		WHERE chain_id = ? AND metric = ?
	`, chainID, metric).Scan(&ts)
	if err != nil || ts == 0 {
		return 0, false
	}
	return ts, true
}

// --- Watermarks ---

// Watermark holds timestamp and version
type Watermark struct {
	LastTs  int64
	Version string
}

func (s *Store) SetWatermark(chainID uint32, metric, granularity string, ts int64, version string) error {
	_, err := s.db.Exec(`
		INSERT OR REPLACE INTO watermarks (chain_id, metric, granularity, last_ts, version)
		VALUES (?, ?, ?, ?, ?)
	`, chainID, metric, granularity, ts, version)
	return err
}

func (s *Store) GetWatermark(chainID uint32, metric, granularity string) (Watermark, bool) {
	var wm Watermark
	err := s.db.QueryRow(`
		SELECT last_ts, version FROM watermarks
		WHERE chain_id = ? AND metric = ? AND granularity = ?
	`, chainID, metric, granularity).Scan(&wm.LastTs, &wm.Version)
	if err == sql.ErrNoRows {
		return Watermark{}, false
	}
	if err != nil {
		log.Printf("get watermark error: %v", err)
		return Watermark{}, false
	}
	return wm, true
}

// DeleteMetricData removes all data for a metric/granularity combo (for version reset)
func (s *Store) DeleteMetricData(chainID uint32, metric, granularity string) error {
	_, err := s.db.Exec(`
		DELETE FROM metrics WHERE chain_id = ? AND metric = ? AND granularity = ?
	`, chainID, metric, granularity)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`
		DELETE FROM watermarks WHERE chain_id = ? AND metric = ? AND granularity = ?
	`, chainID, metric, granularity)
	return err
}

// --- Batch Operations ---

type Batch struct {
	tx *sql.Tx
}

func (s *Store) NewBatch() (*Batch, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	return &Batch{tx: tx}, nil
}

func (b *Batch) SetMetric(chainID uint32, metric, granularity string, ts int64, value string) error {
	_, err := b.tx.Exec(`
		INSERT OR REPLACE INTO metrics (chain_id, metric, granularity, ts, value)
		VALUES (?, ?, ?, ?, ?)
	`, chainID, metric, granularity, ts, value)
	return err
}

func (b *Batch) SetWatermark(chainID uint32, metric, granularity string, ts int64, version string) error {
	_, err := b.tx.Exec(`
		INSERT OR REPLACE INTO watermarks (chain_id, metric, granularity, last_ts, version)
		VALUES (?, ?, ?, ?, ?)
	`, chainID, metric, granularity, ts, version)
	return err
}

func (b *Batch) Commit() error {
	return b.tx.Commit()
}

func (b *Batch) Rollback() error {
	return b.tx.Rollback()
}

// GetChains returns all distinct chain IDs from metrics table (excludes total chain)
func (s *Store) GetChains() []uint32 {
	rows, err := s.db.Query(`
		SELECT DISTINCT chain_id FROM metrics 
		WHERE chain_id != 4294967295 
		ORDER BY chain_id
	`)
	if err != nil {
		return nil
	}
	defer rows.Close()

	var chains []uint32
	for rows.Next() {
		var chainID uint32
		if err := rows.Scan(&chainID); err == nil {
			chains = append(chains, chainID)
		}
	}
	return chains
}
