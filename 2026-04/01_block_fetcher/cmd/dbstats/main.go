package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"sort"

	"github.com/erigontech/mdbx-go/mdbx"
)

var tableNames = []string{
	"Containers",
	"ContainerIndex",
	"BlockHashIndex",
	"AccountState",
	"Code",
	"StorageState",
	"AddressIndex",
	"SlotIndex",
	"Changesets",
	"HistoryIndex",
	"AccountTrie",
	"StorageTrie",
	"Metadata",
	"EthDB",
	"HashedAccountState",
	"HashedStorageState",
	"ReceiptsByBlock",
	"TxHashIndex",
	"AddressLogIndex",
	"TopicLogIndex",
}

type tableStat struct {
	Name     string
	Bytes    uint64
	Entries  uint64
	Depth    uint
	Branch   uint64
	Leaf     uint64
	Overflow uint64
}

func main() {
	dbDir := flag.String("db-dir", "data/mainnet-mdbx", "MDBX database directory")
	flag.Parse()

	env, err := mdbx.NewEnv(mdbx.Label("dbstats"))
	if err != nil {
		log.Fatalf("new env: %v", err)
	}
	defer env.Close()

	if err := env.SetOption(mdbx.OptMaxDB, 24); err != nil {
		log.Fatalf("set maxdb: %v", err)
	}
	flags := uint(mdbx.Readonly | mdbx.NoReadahead | mdbx.NoStickyThreads)
	if err := env.Open(*dbDir, flags, 0644); err != nil {
		log.Fatalf("open env: %v", err)
	}
	if stale, err := env.ReaderCheck(); err == nil && stale > 0 {
		log.Printf("released %d stale readers", stale)
	}

	envStat, err := env.Stat()
	if err != nil {
		log.Fatalf("env stat: %v", err)
	}
	dataFile, err := os.Stat(*dbDir + "/mdbx.dat")
	if err != nil {
		log.Fatalf("stat mdbx.dat: %v", err)
	}

	txn, err := env.BeginTxn(nil, mdbx.TxRO)
	if err != nil {
		log.Fatalf("begin ro txn: %v", err)
	}
	defer txn.Abort()

	stats := make([]tableStat, 0, len(tableNames)+1)
	rootDBI, err := txn.OpenRoot(0)
	if err == nil {
		if stat, err := txn.StatDBI(rootDBI); err == nil {
			stats = append(stats, makeTableStat("(root)", stat))
		}
	}
	for _, name := range tableNames {
		dbi, err := txn.OpenDBISimple(name, 0)
		if err != nil {
			log.Printf("open dbi %s: %v", name, err)
			continue
		}
		stat, err := txn.StatDBI(dbi)
		if err != nil {
			log.Printf("stat dbi %s: %v", name, err)
			continue
		}
		stats = append(stats, makeTableStat(name, stat))
	}

	sort.Slice(stats, func(i, j int) bool {
		if stats[i].Bytes == stats[j].Bytes {
			return stats[i].Name < stats[j].Name
		}
		return stats[i].Bytes > stats[j].Bytes
	})

	var totalBytes uint64
	for _, stat := range stats {
		totalBytes += stat.Bytes
	}

	fmt.Printf("db_dir=%s\n", *dbDir)
	fmt.Printf("mdbx.dat=%d bytes (%s)\n", dataFile.Size(), humanBytes(uint64(dataFile.Size())))
	envBytes := uint64(envStat.PSize) * (envStat.BranchPages + envStat.LeafPages + envStat.OverflowPages)
	fmt.Printf("env_pages=%d bytes (%s) page_size=%d entries=%d\n", envBytes, humanBytes(envBytes), envStat.PSize, envStat.Entries)
	fmt.Printf("tables_total=%d bytes (%s)\n", totalBytes, humanBytes(totalBytes))
	if uint64(dataFile.Size()) > totalBytes {
		freeish := uint64(dataFile.Size()) - totalBytes
		fmt.Printf("unattributed=%d bytes (%s)\n", freeish, humanBytes(freeish))
	}
	fmt.Println()
	fmt.Printf("%-20s %12s %12s %8s %10s %10s %10s\n", "table", "size", "items", "depth", "branch", "leaf", "overflow")
	for _, stat := range stats {
		fmt.Printf("%-20s %12s %12d %8d %10d %10d %10d\n",
			stat.Name,
			humanBytes(stat.Bytes),
			stat.Entries,
			stat.Depth,
			stat.Branch,
			stat.Leaf,
			stat.Overflow,
		)
	}
}

func makeTableStat(name string, stat *mdbx.Stat) tableStat {
	bytes := uint64(stat.PSize) * (stat.BranchPages + stat.LeafPages + stat.OverflowPages)
	return tableStat{
		Name:     name,
		Bytes:    bytes,
		Entries:  stat.Entries,
		Depth:    stat.Depth,
		Branch:   stat.BranchPages,
		Leaf:     stat.LeafPages,
		Overflow: stat.OverflowPages,
	}
}

func humanBytes(v uint64) string {
	const unit = 1024
	if v < unit {
		return fmt.Sprintf("%dB", v)
	}
	div, exp := uint64(unit), 0
	for n := v / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f%ciB", float64(v)/float64(div), "KMGTPE"[exp])
}
