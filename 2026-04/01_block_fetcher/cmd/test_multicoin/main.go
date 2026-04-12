package main

import (
	"bytes"
	"fmt"

	corethcore "github.com/ava-labs/avalanchego/graft/coreth/core"
	ccustomtypes "github.com/ava-labs/avalanchego/graft/coreth/plugin/evm/customtypes"
	"github.com/ava-labs/libevm/core/types"
	"github.com/ava-labs/libevm/rlp"
)

func init() {
	corethcore.RegisterExtras()
}

func main() {
	// Test 1: create account without multicoin (skip IsAccountMultiCoin — panics on nil Extra)

	// Test 2: set multicoin via our RLP trick
	sa2 := &types.StateAccount{Nonce: 2}
	if sa2.Extra == nil {
		sa2.Extra = &types.StateAccountExtra{}
	}
	encoded, _ := rlp.EncodeToBytes(true)
	err := sa2.Extra.DecodeRLP(rlp.NewStream(bytes.NewReader(encoded), uint64(len(encoded))))
	fmt.Printf("sa2 DecodeRLP err: %v\n", err)
	fmt.Printf("sa2 isMultiCoin: %v\n", ccustomtypes.IsAccountMultiCoin(sa2))

	// Test 3: RLP encode and check
	sa1 := &types.StateAccount{Nonce: 1}
	enc1, _ := rlp.EncodeToBytes(sa1)
	enc2, _ := rlp.EncodeToBytes(sa2)
	fmt.Printf("sa1 RLP (%d bytes): %x\n", len(enc1), enc1)
	fmt.Printf("sa2 RLP (%d bytes): %x\n", len(enc2), enc2)
}
