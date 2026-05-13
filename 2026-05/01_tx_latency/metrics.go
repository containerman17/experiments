package main

import (
	"strconv"

	"github.com/prometheus/client_golang/prometheus"
)

type Metrics struct {
	chainIDLabel string
	region       string

	InclusionLatency *prometheus.HistogramVec
	TxsTotal         *prometheus.CounterVec
	ReceiptsTotal    *prometheus.CounterVec
	PendingTxs       *prometheus.GaugeVec
	WalletBalance    *prometheus.GaugeVec
	TxsRemaining     *prometheus.GaugeVec
	LatestBlock      *prometheus.GaugeVec
	Up               *prometheus.GaugeVec
}

func NewMetrics(reg prometheus.Registerer, region string, chainID uint64) *Metrics {
	chainIDLabel := strconv.FormatUint(chainID, 10)

	inclusionBuckets := []float64{
		0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.4, 1.5,
		1.75, 2.0, 2.25, 2.5, 3.0,
		5.0,
	}

	m := &Metrics{
		chainIDLabel: chainIDLabel,
		region:       region,
		InclusionLatency: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "txlat_inclusion_latency_seconds",
			Help:    "Seconds between local tx sign timestamp and block.timestampMilliseconds.",
			Buckets: inclusionBuckets,
		}, []string{"region", "chain_id"}),
		TxsTotal: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "txlat_transactions_total",
			Help: "Submitted transactions partitioned by send result status.",
		}, []string{"region", "chain_id", "status"}),
		ReceiptsTotal: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "txlat_receipts_total",
			Help: "Observed receipts partitioned by on-chain status.",
		}, []string{"region", "chain_id", "status"}),
		PendingTxs: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "txlat_pending_transactions",
			Help: "Number of tracked transactions not yet observed in a block.",
		}, []string{"region", "chain_id"}),
		WalletBalance: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "txlat_wallet_balance_avax",
			Help: "Wallet native balance in AVAX.",
		}, []string{"region", "address", "chain_id"}),
		TxsRemaining: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "txlat_estimated_txs_remaining",
			Help: "Estimated number of benchmark txs the current balance can fund.",
		}, []string{"region", "address", "chain_id"}),
		LatestBlock: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "txlat_latest_block_number",
			Help: "Highest block number observed by the scanner.",
		}, []string{"region", "chain_id"}),
		Up: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "txlat_up",
			Help: "1 if the service is running.",
		}, []string{"region", "chain_id"}),
	}

	reg.MustRegister(
		m.InclusionLatency,
		m.TxsTotal,
		m.ReceiptsTotal,
		m.PendingTxs,
		m.WalletBalance,
		m.TxsRemaining,
		m.LatestBlock,
		m.Up,
	)
	m.Up.WithLabelValues(region, chainIDLabel).Set(1)
	return m
}

func (m *Metrics) ObserveInclusionLatency(seconds float64) {
	m.InclusionLatency.WithLabelValues(m.region, m.chainIDLabel).Observe(seconds)
}

func (m *Metrics) IncTxSend(status string) {
	m.TxsTotal.WithLabelValues(m.region, m.chainIDLabel, status).Inc()
}

func (m *Metrics) IncReceipt(status string) {
	m.ReceiptsTotal.WithLabelValues(m.region, m.chainIDLabel, status).Inc()
}

func (m *Metrics) SetPending(n int) {
	m.PendingTxs.WithLabelValues(m.region, m.chainIDLabel).Set(float64(n))
}

func (m *Metrics) SetBalance(addr string, avax float64) {
	m.WalletBalance.WithLabelValues(m.region, addr, m.chainIDLabel).Set(avax)
}

func (m *Metrics) SetTxsRemaining(addr string, n float64) {
	m.TxsRemaining.WithLabelValues(m.region, addr, m.chainIDLabel).Set(n)
}

func (m *Metrics) SetLatestBlock(n uint64) {
	m.LatestBlock.WithLabelValues(m.region, m.chainIDLabel).Set(float64(n))
}
