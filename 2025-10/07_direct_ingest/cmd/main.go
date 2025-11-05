package main

import (
	"os"

	"github.com/spf13/cobra"
)

func main() {
	root := &cobra.Command{Use: "clickhouse-ingest"}

	root.AddCommand(
		&cobra.Command{
			Use:   "ingest",
			Short: "Start the continuous ingestion process",
			Run:   func(cmd *cobra.Command, args []string) { runIngest() },
		},
		&cobra.Command{
			Use:   "size",
			Short: "Show ClickHouse table sizes and disk usage",
			Run:   func(cmd *cobra.Command, args []string) { runSize() },
		},
		&cobra.Command{
			Use:   "wipe",
			Short: "Drop calculated tables (keeps raw_* and sync_watermark)",
			Run:   func(cmd *cobra.Command, args []string) { runWipe() },
		},
	)

	if err := root.Execute(); err != nil {
		os.Exit(1)
	}
}
