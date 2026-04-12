package statetrie

import (
	"bytes"

	"github.com/ava-labs/libevm/core/types"
	"github.com/ava-labs/libevm/rlp"
)

// setMultiCoinOnAccount sets the isMultiCoin extra to true on a StateAccount.
// This is needed because coreth's customtypes package doesn't export a setter
// for StateOrSlimAccount (only for *state.StateDB).
func setMultiCoinOnAccount(sa *types.StateAccount) {
	if sa.Extra == nil {
		sa.Extra = &types.StateAccountExtra{}
	}
	// Encode `true` as RLP, then decode it into the Extra field.
	encoded, _ := rlp.EncodeToBytes(true)
	_ = sa.Extra.DecodeRLP(rlp.NewStream(bytes.NewReader(encoded), uint64(len(encoded))))
}
