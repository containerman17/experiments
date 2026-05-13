package main

import (
	"crypto/ecdsa"
	"fmt"
	"math/big"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
)

type Wallet struct {
	key     *ecdsa.PrivateKey
	addr    common.Address
	chainID *big.Int
	signer  types.Signer
}

func LoadWallet(privHex string, chainID uint64) (*Wallet, error) {
	key, err := crypto.HexToECDSA(privHex)
	if err != nil {
		return nil, fmt.Errorf("invalid PRIVATE_KEY: %w", err)
	}
	addr := crypto.PubkeyToAddress(key.PublicKey)
	cid := new(big.Int).SetUint64(chainID)
	return &Wallet{
		key:     key,
		addr:    addr,
		chainID: cid,
		signer:  types.LatestSignerForChainID(cid),
	}, nil
}

func (w *Wallet) Address() common.Address {
	return w.addr
}

type SignedTx struct {
	Hash     common.Hash
	Nonce    uint64
	RawHex   string
	GasLimit uint64
	GasPrice *big.Int
}

// BuildAndSign builds and signs a legacy zero-value self-transfer with the given calldata.
func (w *Wallet) BuildAndSign(nonce uint64, gasPrice *big.Int, gasLimit uint64, data []byte) (*SignedTx, error) {
	tx := types.NewTx(&types.LegacyTx{
		Nonce:    nonce,
		GasPrice: new(big.Int).Set(gasPrice),
		Gas:      gasLimit,
		To:       &w.addr,
		Value:    new(big.Int),
		Data:     data,
	})
	signed, err := types.SignTx(tx, w.signer, w.key)
	if err != nil {
		return nil, fmt.Errorf("sign tx: %w", err)
	}
	raw, err := signed.MarshalBinary()
	if err != nil {
		return nil, fmt.Errorf("encode tx: %w", err)
	}
	return &SignedTx{
		Hash:     signed.Hash(),
		Nonce:    nonce,
		RawHex:   hexutil.Encode(raw),
		GasLimit: gasLimit,
		GasPrice: new(big.Int).Set(gasPrice),
	}, nil
}
