package store

import (
	"encoding/binary"

	"github.com/erigontech/mdbx-go/mdbx"
)

type Account struct {
	Nonce    uint64
	Balance  [32]byte // uint256 big-endian
	CodeHash [32]byte
}

// EmptyCodeHash is the keccak256 of empty bytes.
var EmptyCodeHash = [32]byte{
	0xc5, 0xd2, 0x46, 0x01, 0x86, 0xf7, 0x23, 0x3c,
	0x92, 0x7e, 0x7d, 0xb2, 0xdc, 0xc7, 0x03, 0xc0,
	0xe5, 0x00, 0xb6, 0x53, 0xca, 0x82, 0x27, 0x3b,
	0x7b, 0xfa, 0xd8, 0x04, 0x5d, 0x85, 0xa4, 0x70,
}

const accountSize = 8 + 32 + 32 // 72

func encodeAccount(acct *Account) [accountSize]byte {
	var buf [accountSize]byte
	binary.BigEndian.PutUint64(buf[:8], acct.Nonce)
	copy(buf[8:40], acct.Balance[:])
	copy(buf[40:72], acct.CodeHash[:])
	return buf
}

// DecodeAccount decodes an account from its binary representation.
func DecodeAccount(data []byte) *Account {
	return decodeAccount(data)
}

func decodeAccount(data []byte) *Account {
	acct := &Account{}
	acct.Nonce = binary.BigEndian.Uint64(data[:8])
	copy(acct.Balance[:], data[8:40])
	copy(acct.CodeHash[:], data[40:72])
	return acct
}

// PutAccount stores an account record.
func PutAccount(tx *mdbx.Txn, db *DB, addr [20]byte, acct *Account) error {
	buf := encodeAccount(acct)
	return tx.Put(db.AccountState, addr[:], buf[:], 0)
}

// GetAccount retrieves an account. Returns nil if not found.
func GetAccount(tx *mdbx.Txn, db *DB, addr [20]byte) (*Account, error) {
	data, err := tx.Get(db.AccountState, addr[:])
	if err != nil {
		if mdbx.IsNotFound(err) {
			return nil, nil
		}
		return nil, err
	}
	return decodeAccount(data), nil
}

// PutCode stores contract bytecode keyed by its hash.
func PutCode(tx *mdbx.Txn, db *DB, codeHash [32]byte, code []byte) error {
	return tx.Put(db.Code, codeHash[:], code, 0)
}

// GetCode retrieves contract bytecode by hash. Returns nil if not found.
func GetCode(tx *mdbx.Txn, db *DB, codeHash [32]byte) ([]byte, error) {
	data, err := tx.Get(db.Code, codeHash[:])
	if err != nil {
		if mdbx.IsNotFound(err) {
			return nil, nil
		}
		return nil, err
	}
	return data, nil
}

var zeroValue [32]byte

// PutStorage stores a storage slot value. If value is all zeros, deletes the entry.
func PutStorage(tx *mdbx.Txn, db *DB, addr [20]byte, slot [32]byte, value [32]byte) error {
	key := StorageKey(addr, slot)
	if value == zeroValue {
		err := tx.Del(db.StorageState, key[:], nil)
		if mdbx.IsNotFound(err) {
			return nil
		}
		return err
	}
	// Strip leading zero bytes for compactness.
	v := value[:]
	for len(v) > 1 && v[0] == 0 {
		v = v[1:]
	}
	return tx.Put(db.StorageState, key[:], v, 0)
}

// GetStorage retrieves a storage slot value. Returns zero hash if not found.
func GetStorage(tx *mdbx.Txn, db *DB, addr [20]byte, slot [32]byte) ([32]byte, error) {
	key := StorageKey(addr, slot)
	data, err := tx.Get(db.StorageState, key[:])
	if err != nil {
		if mdbx.IsNotFound(err) {
			return [32]byte{}, nil
		}
		return [32]byte{}, err
	}
	// Pad back to 32 bytes, right-aligned.
	var result [32]byte
	copy(result[32-len(data):], data)
	return result, nil
}
