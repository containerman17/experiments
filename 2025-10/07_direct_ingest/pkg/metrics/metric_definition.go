package metrics

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

type MetricDefinition struct {
	Name          string
	SQLTemplate   string
	TableCreation string
	Granularities []string // Minute, Hour, Day, Week, Month - extracted from SQL
}

// loadMetrics scans the sql/metrics directory and loads all metric definitions
func loadMetrics(sqlDir string) ([]MetricDefinition, error) {
	metrics := []MetricDefinition{}

	files, err := os.ReadDir(sqlDir)
	if err != nil {
		return nil, fmt.Errorf("failed to read metrics directory: %w", err)
	}

	for _, file := range files {
		if !strings.HasSuffix(file.Name(), ".sql") {
			continue
		}

		path := filepath.Join(sqlDir, file.Name())
		content, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("failed to read %s: %w", file.Name(), err)
		}

		metric, err := parseMetricSQL(file.Name(), string(content))
		if err != nil {
			return nil, fmt.Errorf("failed to parse %s: %w", file.Name(), err)
		}

		metrics = append(metrics, metric)
	}

	return metrics, nil
}

// parseMetricSQL extracts metric definition from SQL file content
func parseMetricSQL(filename, content string) (MetricDefinition, error) {
	metric := MetricDefinition{
		Name: strings.TrimSuffix(filename, ".sql"),
	}

	// Split by CREATE TABLE and INSERT to get both parts
	parts := strings.Split(content, "INSERT INTO")
	if len(parts) != 2 {
		// Some metrics might not have CREATE TABLE (like cumulative ones that don't use {granularity})
		metric.SQLTemplate = content
		metric.Granularities = extractGranularities(content)
		return metric, nil
	}

	metric.TableCreation = parts[0]
	metric.SQLTemplate = "INSERT INTO" + parts[1]
	metric.Granularities = extractGranularities(content)

	return metric, nil
}

// extractGranularities finds what time granularities this metric supports
func extractGranularities(sql string) []string {
	granularities := []string{}

	// Cumulative metrics support all granularities (they're just up-and-to-the-right charts)

	// Check for {granularity} placeholder - means it supports multiple
	if strings.Contains(sql, "{granularity}") {
		// Default set based on what makes sense
		if strings.Contains(sql, "toStartOf") {
			granularities = []string{"Minute", "Hour", "Day", "Week", "Month"}
		}
	} else {
		// Fixed granularity - check what's hardcoded
		if strings.Contains(sql, "toDate(") || strings.Contains(sql, "_daily") {
			granularities = []string{"Day"}
		} else if strings.Contains(sql, "toStartOfHour") {
			granularities = []string{"Hour"}
		} else if strings.Contains(sql, "toStartOfMinute") {
			granularities = []string{"Minute"}
		}
		// Add more as needed
	}

	// If we couldn't determine, default to Day
	if len(granularities) == 0 {
		granularities = []string{"Day"}
	}

	return granularities
}

// getTableName extracts the target table name from the SQL template
func (m *MetricDefinition) getTableName(granularity string) string {
	// Extract table name from INSERT INTO statement
	re := regexp.MustCompile(`INSERT INTO\s+(\S+)`)
	matches := re.FindStringSubmatch(m.SQLTemplate)
	if len(matches) > 1 {
		tableName := matches[1]
		// Replace {granularity} placeholder if present
		tableName = strings.ReplaceAll(tableName, "{granularity}", strings.ToLower(granularity))
		return tableName
	}
	return ""
}
