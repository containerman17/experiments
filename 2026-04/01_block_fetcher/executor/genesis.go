package executor

import (
	"encoding/json"
	"fmt"

	"github.com/ava-labs/avalanchego/genesis"
	corethcore "github.com/ava-labs/avalanchego/graft/coreth/core"
	"github.com/ava-labs/avalanchego/utils/constants"
	"github.com/ava-labs/libevm/common"
	"github.com/ava-labs/libevm/crypto"
	"github.com/erigontech/mdbx-go/mdbx"
	"github.com/holiman/uint256"

	"block_fetcher/store"
)

// LoadGenesis writes the C-Chain genesis state to the flat state tables.
// It uses the mainnet genesis configuration from AvalancheGo.
func LoadGenesis(tx *mdbx.Txn, db *store.DB) error {
	// Get the mainnet genesis config which contains the C-Chain genesis JSON.
	config := genesis.GetConfig(constants.MainnetID)

	// Parse the C-Chain genesis JSON to extract allocations.
	var cChainGenesis corethcore.Genesis
	if err := json.Unmarshal([]byte(config.CChainGenesis), &cChainGenesis); err != nil {
		return fmt.Errorf("failed to parse C-Chain genesis: %w", err)
	}

	for addr, account := range cChainGenesis.Alloc {
		var addr20 [20]byte
		copy(addr20[:], addr[:])

		// Determine code hash.
		codeHash := store.EmptyCodeHash
		if len(account.Code) > 0 {
			codeHash = [32]byte(crypto.Keccak256Hash(account.Code))
			if err := store.PutCode(tx, db, codeHash, account.Code); err != nil {
				return fmt.Errorf("failed to put code for %s: %w", addr.Hex(), err)
			}
		}

		// Convert balance to big-endian 32-byte representation.
		var balance [32]byte
		if account.Balance != nil {
			bal, overflow := uint256.FromBig(account.Balance)
			if overflow {
				return fmt.Errorf("balance overflow for %s", addr.Hex())
			}
			bal.WriteToArray32(&balance)
		}

		acct := &store.Account{
			Nonce:    account.Nonce,
			Balance:  balance,
			CodeHash: codeHash,
		}
		if err := store.PutAccount(tx, db, addr20, acct); err != nil {
			return fmt.Errorf("failed to put account %s: %w", addr.Hex(), err)
		}

		// Write storage slots.
		for slot, value := range account.Storage {
			if err := store.PutStorage(tx, db, addr20, [32]byte(slot), [32]byte(value)); err != nil {
				return fmt.Errorf("failed to put storage for %s slot %s: %w",
					addr.Hex(), slot.Hex(), err)
			}
		}
	}

	// Store genesis block number in metadata to mark that genesis has been loaded.
	if err := tx.Put(db.Metadata, []byte("genesis_loaded"), []byte{1}, 0); err != nil {
		return fmt.Errorf("failed to mark genesis loaded: %w", err)
	}

	return nil
}

// IsGenesisLoaded checks whether the genesis state has already been loaded.
func IsGenesisLoaded(tx *mdbx.Txn, db *store.DB) (bool, error) {
	_, err := tx.Get(db.Metadata, []byte("genesis_loaded"))
	if err != nil {
		if mdbx.IsNotFound(err) {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

// GenesisAllocCount returns the number of accounts in the mainnet C-Chain genesis.
// Useful for logging/progress reporting.
func GenesisAllocCount() (int, error) {
	config := genesis.GetConfig(constants.MainnetID)
	var cChainGenesis corethcore.Genesis
	if err := json.Unmarshal([]byte(config.CChainGenesis), &cChainGenesis); err != nil {
		return 0, fmt.Errorf("failed to parse C-Chain genesis: %w", err)
	}
	return len(cChainGenesis.Alloc), nil
}

// GenesisStateRoot is not needed for flat-state storage, but provided for
// verification. It returns the expected state root of the genesis block.
func GenesisStateRoot() common.Hash {
	config := genesis.GetConfig(constants.MainnetID)
	var cChainGenesis corethcore.Genesis
	if err := json.Unmarshal([]byte(config.CChainGenesis), &cChainGenesis); err != nil {
		return common.Hash{}
	}
	return cChainGenesis.ToBlock().Root()
}
