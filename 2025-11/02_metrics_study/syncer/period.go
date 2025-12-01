package syncer

import (
	"database/sql"
	"math/big"
	"time"
)

// Period represents a time period
type Period struct {
	Start time.Time
	End   time.Time
}

// Truncate helpers - return unix timestamp for comparison (includes year)
func truncHour(t time.Time) int64  { return t.Truncate(time.Hour).Unix() }
func truncDay(t time.Time) int64   { return t.Truncate(24 * time.Hour).Unix() }
func truncWeek(t time.Time) int64  { return truncateToPeriod(t, Week).Unix() }
func truncMonth(t time.Time) int64 { return truncateToPeriod(t, Month).Unix() }

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
		// Week starts on Monday (matches prod)
		weekday := int(t.Weekday())
		if weekday == 0 {
			weekday = 7 // Sunday becomes 7
		}
		return time.Date(t.Year(), t.Month(), t.Day()-(weekday-1), 0, 0, 0, 0, time.UTC)
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
