package main

import (
	"encoding/binary"
	"flag"
	"log"
	"runtime"

	"github.com/erigontech/mdbx-go/mdbx"

	"block_fetcher/store"
)

func main() {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	srcDir := flag.String("src", "data/mainnet-mdbx", "source MDBX directory")
	dstDir := flag.String("dst", "/tmp/mainnet-mdbx-copy", "destination MDBX directory")
	fromBlock := flag.Uint64("from", 1, "first block to copy")
	toBlock := flag.Uint64("to", 0, "last block to copy (required)")
	flag.Parse()

	if *toBlock == 0 {
		log.Fatal("-to is required")
	}
	if *fromBlock > *toBlock {
		log.Fatalf("invalid range: from=%d to=%d", *fromBlock, *toBlock)
	}

	src, err := store.Open(*srcDir)
	if err != nil {
		log.Fatalf("open source DB: %v", err)
	}
	defer src.Close()

	dst, err := store.Open(*dstDir)
	if err != nil {
		log.Fatalf("open destination DB: %v", err)
	}
	defer dst.Close()

	srcTx, err := src.BeginRO()
	if err != nil {
		log.Fatalf("begin source RO tx: %v", err)
	}
	defer srcTx.Abort()

	dstTx, err := dst.BeginRW()
	if err != nil {
		log.Fatalf("begin destination RW tx: %v", err)
	}
	defer dstTx.Abort()

	cursor, err := srcTx.OpenCursor(src.ContainerIndex)
	if err != nil {
		log.Fatalf("open source ContainerIndex cursor: %v", err)
	}
	defer cursor.Close()

	startKey := store.BlockKey(*fromBlock)
	k, cid, err := cursor.Get(startKey[:], nil, mdbx.SetRange)
	if err != nil {
		log.Fatalf("seek source ContainerIndex: %v", err)
	}

	var copied uint64
	for err == nil && len(k) == 8 {
		blockNum := binary.BigEndian.Uint64(k)
		if blockNum > *toBlock {
			break
		}

		compressed, err := srcTx.Get(src.Containers, cid)
		if err != nil {
			log.Fatalf("get container %d: %v", blockNum, err)
		}
		if err := dstTx.Put(dst.Containers, cid, compressed, 0); err != nil {
			log.Fatalf("put destination container %d: %v", blockNum, err)
		}
		if err := dstTx.Put(dst.ContainerIndex, k, cid, 0); err != nil {
			log.Fatalf("put destination index %d: %v", blockNum, err)
		}

		copied++
		if copied%100000 == 0 {
			log.Printf("copied %d blocks through %d", copied, blockNum)
		}

		k, cid, err = cursor.Get(nil, nil, mdbx.Next)
	}
	if err != nil && !mdbx.IsNotFound(err) {
		log.Fatalf("scan source ContainerIndex: %v", err)
	}

	latest := store.BlockKey(*toBlock)
	if err := dstTx.Put(dst.Metadata, []byte("latest_block"), latest[:], 0); err != nil {
		log.Fatalf("set latest_block: %v", err)
	}

	if _, err := dstTx.Commit(); err != nil {
		log.Fatalf("commit destination DB: %v", err)
	}

	log.Printf("copy finished successfully: copied %d blocks into %s through block %d", copied, *dstDir, *toBlock)
}
