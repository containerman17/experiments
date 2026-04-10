package main

import (
	"flag"
	"log"
	"os"

	cparams "github.com/ava-labs/avalanchego/graft/coreth/params"
	"github.com/ava-labs/avalanchego/graft/coreth/plugin/evm/customtypes"

	"block_fetcher/executor"
	"block_fetcher/store"
	"block_fetcher/trie"
)

func main() {
	cparams.RegisterExtras()
	customtypes.Register()

	dbDir := flag.String("db", "data/mainnet-mdbx", "MDBX directory")
	flag.Parse()

	os.RemoveAll(*dbDir)
	db, err := store.Open(*dbDir)
	if err != nil {
		log.Fatalf("open: %v", err)
	}
	defer db.Close()

	// Load genesis
	rwTx, err := db.BeginRW()
	if err != nil {
		log.Fatalf("begin RW: %v", err)
	}
	if err := executor.LoadGenesis(rwTx, db); err != nil {
		rwTx.Abort()
		log.Fatalf("load genesis: %v", err)
	}
	if _, err := rwTx.Commit(); err != nil {
		log.Fatalf("commit: %v", err)
	}

	// Compute state root from our flat state
	roTx, err := db.BeginRO()
	if err != nil {
		log.Fatalf("begin RO: %v", err)
	}
	defer roTx.Abort()

	computed, _, err := trie.ComputeStateRoot(roTx, db, nil)
	if err != nil {
		log.Fatalf("compute state root: %v", err)
	}

	expected := executor.GenesisStateRoot()

	log.Printf("Expected genesis root: %x", expected)
	log.Printf("Computed genesis root: %x", computed)
	if computed == expected {
		log.Printf("MATCH!")
	} else {
		log.Printf("MISMATCH — genesis loading or trie computation is wrong")
	}
}
