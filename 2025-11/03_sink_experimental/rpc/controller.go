package rpc

import (
	"context"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

const (
	windowDuration       = 60 * time.Second
	adjustInterval       = 5 * time.Second
	defaultMaxParallel   = 50
	defaultTargetLatency = 1200 * time.Millisecond // 200ms ping + 1s work = healthy
	defaultMaxLatency    = 2000 * time.Millisecond // Hard ceiling before backoff
	defaultMaxErrors     = 10
)

type RequestMetric struct {
	Timestamp time.Time
	Duration  time.Duration
	Success   bool
}

type Controller struct {
	url             string
	maxParallelism  int
	minParallelism  int
	targetLatency   time.Duration
	maxLatency      time.Duration
	maxErrorsPerMin int

	currentParallel atomic.Int32
	semaphore       chan struct{}

	metrics   []RequestMetric
	metricsMu sync.Mutex

	stopCh chan struct{}
	wg     sync.WaitGroup
}

func NewController(cfg RPCConfig) *Controller {
	maxP := cfg.MaxParallelism
	if maxP <= 0 {
		maxP = defaultMaxParallel
	}

	// Derive everything else from maxParallelism
	minP := max(2, maxP/10)               // Floor at 10% of max, minimum 2
	targetLatency := defaultTargetLatency // 800ms - good for most nodes
	maxLatency := defaultMaxLatency       // 2s - if slower, something's wrong
	maxErrors := defaultMaxErrors         // 10 errors/min triggers backoff

	c := &Controller{
		url:             cfg.URL,
		maxParallelism:  maxP,
		minParallelism:  minP,
		targetLatency:   targetLatency,
		maxLatency:      maxLatency,
		maxErrorsPerMin: maxErrors,
		semaphore:       make(chan struct{}, maxP),
		metrics:         make([]RequestMetric, 0, 1000),
		stopCh:          make(chan struct{}),
	}
	c.currentParallel.Store(int32(maxP))

	// Fill semaphore to current capacity
	for i := 0; i < maxP; i++ {
		c.semaphore <- struct{}{}
	}

	// Start adjustment loop
	c.wg.Add(1)
	go c.adjustLoop()

	return c
}

func (c *Controller) URL() string {
	return c.url
}

func (c *Controller) CurrentParallelism() int {
	return int(c.currentParallel.Load())
}

// Acquire blocks until a slot is available
func (c *Controller) Acquire(ctx context.Context) error {
	select {
	case <-c.semaphore:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Release returns a slot to the pool
func (c *Controller) Release() {
	select {
	case c.semaphore <- struct{}{}:
	default:
		// Semaphore full (parallelism was reduced), discard
	}
}

// RecordMetric records the result of a request
func (c *Controller) RecordMetric(duration time.Duration, success bool) {
	c.metricsMu.Lock()
	c.metrics = append(c.metrics, RequestMetric{
		Timestamp: time.Now(),
		Duration:  duration,
		Success:   success,
	})
	c.metricsMu.Unlock()
}

// Execute runs fn with rate limiting and records metrics
func (c *Controller) Execute(ctx context.Context, fn func() error) error {
	if err := c.Acquire(ctx); err != nil {
		return err
	}
	defer c.Release()

	start := time.Now()
	err := fn()
	c.RecordMetric(time.Since(start), err == nil)
	return err
}

func (c *Controller) adjustLoop() {
	defer c.wg.Done()
	ticker := time.NewTicker(adjustInterval)
	defer ticker.Stop()

	for {
		select {
		case <-c.stopCh:
			return
		case <-ticker.C:
			c.adjust()
		}
	}
}

func (c *Controller) adjust() {
	c.metricsMu.Lock()
	defer c.metricsMu.Unlock()

	// Prune old metrics
	cutoff := time.Now().Add(-windowDuration)
	validStart := 0
	for i, m := range c.metrics {
		if m.Timestamp.After(cutoff) {
			validStart = i
			break
		}
		if i == len(c.metrics)-1 {
			validStart = len(c.metrics)
		}
	}
	c.metrics = c.metrics[validStart:]

	if len(c.metrics) < 10 {
		// Not enough data to make decisions
		return
	}

	// Count errors in window
	errorCount := 0
	var durations []time.Duration
	for _, m := range c.metrics {
		if !m.Success {
			errorCount++
		}
		durations = append(durations, m.Duration)
	}

	// Calculate P95 latency
	sort.Slice(durations, func(i, j int) bool {
		return durations[i] < durations[j]
	})
	p95Idx := int(float64(len(durations)) * 0.95)
	if p95Idx >= len(durations) {
		p95Idx = len(durations) - 1
	}
	p95Latency := durations[p95Idx]

	current := int(c.currentParallel.Load())
	newParallel := current

	// Adjustment logic
	if errorCount > c.maxErrorsPerMin {
		// Aggressive backoff on errors
		newParallel = current / 2
	} else if p95Latency > c.maxLatency {
		// Reduce on high latency
		newParallel = current - 2
	} else if p95Latency > c.targetLatency {
		// Hold steady
		newParallel = current
	} else if p95Latency < c.targetLatency*7/10 {
		// Cautious increase when performing well
		newParallel = current + 1
	}

	// Clamp to bounds
	if newParallel < c.minParallelism {
		newParallel = c.minParallelism
	}
	if newParallel > c.maxParallelism {
		newParallel = c.maxParallelism
	}

	if newParallel != current {
		c.currentParallel.Store(int32(newParallel))
		// Adjust semaphore capacity
		if newParallel > current {
			// Add slots
			for i := 0; i < newParallel-current; i++ {
				select {
				case c.semaphore <- struct{}{}:
				default:
				}
			}
		}
		// If reducing, slots will naturally drain as Release() discards them
	}
}

func (c *Controller) Stop() {
	close(c.stopCh)
	c.wg.Wait()
}
