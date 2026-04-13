package main

import (
	"flag"
	"fmt"
	"log"
	"runtime"

	"github.com/ava-labs/libevm/common"

	"block_fetcher/store"
)

func main() {
	dbDir := flag.String("db", "data/mainnet-mdbx", "MDBX directory")
	addrHex := flag.String("addr", "", "account address")
	slotHex := flag.String("slot", "", "storage slot")
	blockNum := flag.Uint64("block", 0, "block number to read (defaults to head)")
	flag.Parse()

	if *addrHex == "" || *slotHex == "" {
		log.Fatalf("usage: stateprobe -db <dir> -addr <0x...> -slot <0x...> [-block N]")
	}

	addr := common.HexToAddress(*addrHex)
	slot := common.HexToHash(*slotHex)

	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	db, err := store.Open(*dbDir)
	if err != nil {
		log.Fatalf("open db: %v", err)
	}
	defer db.Close()

	tx, err := db.BeginRO()
	if err != nil {
		log.Fatalf("begin RO: %v", err)
	}
	defer tx.Abort()

	head, ok := store.GetHeadBlock(tx, db)
	if !ok {
		log.Fatalf("head block not set")
	}

	readBlock := *blockNum
	if readBlock == 0 {
		readBlock = head
	}

	var val [32]byte
	if readBlock >= head {
		val, err = store.GetStorage(tx, db, [20]byte(addr), [32]byte(slot))
		if err != nil {
			log.Fatalf("read current storage: %v", err)
		}
		fmt.Printf("db=%s head=%d block=%d mode=current\n", *dbDir, head, readBlock)
	} else {
		val, err = store.LookupHistoricalStorage(tx, db, [20]byte(addr), [32]byte(slot), readBlock)
		if err != nil {
			log.Fatalf("read historical storage: %v", err)
		}
		fmt.Printf("db=%s head=%d block=%d mode=historical\n", *dbDir, head, readBlock)
	}
	fmt.Printf("addr=%s\n", addr.Hex())
	fmt.Printf("slot=%s\n", slot.Hex())
	fmt.Printf("value=0x%064x\n", val)
}
