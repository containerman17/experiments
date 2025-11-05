package metrics

import (
	"fmt"
	"time"
)

// toStartOfPeriod returns the start of the period for given granularity (always UTC)
func toStartOfPeriod(t time.Time, granularity string) time.Time {
	t = t.UTC()
	switch granularity {
	case "Minute":
		return time.Date(t.Year(), t.Month(), t.Day(), t.Hour(), t.Minute(), 0, 0, time.UTC)
	case "Hour":
		return time.Date(t.Year(), t.Month(), t.Day(), t.Hour(), 0, 0, 0, time.UTC)
	case "Day":
		return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
	case "Week":
		// Start of week (Sunday, matching ClickHouse toStartOfWeek)
		for t.Weekday() != time.Sunday {
			t = t.AddDate(0, 0, -1)
		}
		return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
	case "Month":
		return time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, time.UTC)
	default:
		panic(fmt.Sprintf("unknown granularity: %s", granularity))
	}
}

// nextPeriod returns the start of the next period
func nextPeriod(t time.Time, granularity string) time.Time {
	switch granularity {
	case "Minute":
		return t.Add(time.Minute)
	case "Hour":
		return t.Add(time.Hour)
	case "Day":
		return t.AddDate(0, 0, 1)
	case "Week":
		return t.AddDate(0, 0, 7)
	case "Month":
		return t.AddDate(0, 1, 0)
	default:
		panic(fmt.Sprintf("unknown granularity: %s", granularity))
	}
}

// isPeriodComplete checks if a period is complete (we have data from next period)
func isPeriodComplete(periodStart time.Time, granularity string, latestBlockTime time.Time) bool {
	periodEnd := nextPeriod(periodStart, granularity)
	return latestBlockTime.After(periodEnd) || latestBlockTime.Equal(periodEnd)
}

// formatPeriodForSQL formats time for ClickHouse based on granularity
func formatPeriodForSQL(t time.Time, granularity string) string {
	// Always use DateTime format now that all metrics use DateTime columns
	// (except cumulative metrics which are handled separately)
	return t.Format("2006-01-02 15:04:05")
}

// getSecondsInPeriod returns the number of seconds in a period
func getSecondsInPeriod(granularity string) int64 {
	switch granularity {
	case "Minute":
		return 60
	case "Hour":
		return 3600
	case "Day":
		return 86400
	case "Week":
		return 604800
	case "Month":
		return 2592000 // 30 days approximation
	default:
		panic(fmt.Sprintf("unknown granularity: %s", granularity))
	}
}

// getUnprocessedPeriods returns all complete but unprocessed periods
func getUnprocessedPeriods(lastProcessed, latestBlockTime time.Time, granularity string) []time.Time {
	periods := []time.Time{}
	
	var current time.Time
	if lastProcessed.IsZero() {
		// Never processed - start from 2020-01-01 (beginning of blockchain time)
		startTime := time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)
		current = toStartOfPeriod(startTime, granularity)
	} else {
		// Start from the next period after last processed
		current = nextPeriod(lastProcessed, granularity)
	}
	
	// Add all complete periods
	for isPeriodComplete(current, granularity, latestBlockTime) {
		periods = append(periods, current)
		current = nextPeriod(current, granularity)
	}
	
	return periods
}
