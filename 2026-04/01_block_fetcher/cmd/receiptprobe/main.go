package main

import (
	"encoding/hex"
	"flag"
	"fmt"
	"log"
	"runtime"

	"github.com/ava-labs/libevm/common"

	"block_fetcher/store"
)

func main() {
	dbDir := flag.String("db", "data/mainnet-mdbx", "MDBX directory")
	txHashHex := flag.String("tx", "", "transaction hash")
	flag.Parse()

	if *txHashHex == "" {
		log.Fatalf("usage: receiptprobe -db <dir> -tx <0x...>")
	}

	txHash := common.HexToHash(*txHashHex)

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

	blockNum, txIndex, err := store.GetTxLocation(tx, db, [32]byte(txHash))
	if err != nil {
		log.Fatalf("lookup tx: %v", err)
	}
	receipts, err := store.ReadBlockReceipts(tx, db, blockNum)
	if err != nil {
		log.Fatalf("read receipts: %v", err)
	}
	if int(txIndex) >= len(receipts) {
		log.Fatalf("tx index %d out of range for block %d", txIndex, blockNum)
	}
	r := receipts[txIndex]

	fmt.Printf("block=%d txIndex=%d status=%d gasUsed=%d cumulativeGas=%d logs=%d\n",
		blockNum, txIndex, r.Status, r.GasUsed, r.CumulativeGas, len(r.Logs))
	for i, l := range r.Logs {
		fmt.Printf("log[%d] addr=%s topics=%d data=0x%s\n", i, common.Address(l.Address).Hex(), len(l.Topics), hex.EncodeToString(l.Data))
		for j, topic := range l.Topics {
			fmt.Printf("  topic[%d]=0x%x\n", j, topic)
		}
	}
}
