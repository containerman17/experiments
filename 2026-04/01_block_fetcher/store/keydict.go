package store

import (
	"encoding/binary"

	"github.com/erigontech/mdbx-go/mdbx"
)

// GetOrAssignKeyID returns the keyID for (addr, slot), assigning new IDs if needed.
// This must be called within a RW transaction.
func GetOrAssignKeyID(tx *mdbx.Txn, db *DB, addr [20]byte, slot [32]byte) (uint64, error) {
	addressID, err := getOrAssignAddressID(tx, db, addr)
	if err != nil {
		return 0, err
	}
	slotID, err := getOrAssignSlotID(tx, db, addressID, slot)
	if err != nil {
		return 0, err
	}
	return KeyIDEncode(addressID, slotID), nil
}

// GetKeyID returns the keyID for (addr, slot), or 0, false if not assigned yet.
// Can be called in RO transaction.
func GetKeyID(tx *mdbx.Txn, db *DB, addr [20]byte, slot [32]byte) (uint64, bool, error) {
	val, err := tx.Get(db.AddressIndex, addr[:])
	if err != nil {
		if mdbx.IsNotFound(err) {
			return 0, false, nil
		}
		return 0, false, err
	}
	addressID := binary.BigEndian.Uint32(val)

	var slotKey [36]byte
	binary.BigEndian.PutUint32(slotKey[:4], addressID)
	copy(slotKey[4:], slot[:])

	val, err = tx.Get(db.SlotIndex, slotKey[:])
	if err != nil {
		if mdbx.IsNotFound(err) {
			return 0, false, nil
		}
		return 0, false, err
	}
	slotID := binary.BigEndian.Uint32(val)

	return KeyIDEncode(addressID, slotID), true, nil
}

func getOrAssignAddressID(tx *mdbx.Txn, db *DB, addr [20]byte) (uint32, error) {
	val, err := tx.Get(db.AddressIndex, addr[:])
	if err == nil {
		return binary.BigEndian.Uint32(val), nil
	}
	if !mdbx.IsNotFound(err) {
		return 0, err
	}

	id, err := getNextCounter(tx, db, "next_address_id")
	if err != nil {
		return 0, err
	}

	var buf [4]byte
	binary.BigEndian.PutUint32(buf[:], id)
	if err := tx.Put(db.AddressIndex, addr[:], buf[:], 0); err != nil {
		return 0, err
	}
	if err := setNextCounter(tx, db, "next_address_id", id+1); err != nil {
		return 0, err
	}
	return id, nil
}

func getOrAssignSlotID(tx *mdbx.Txn, db *DB, addressID uint32, slot [32]byte) (uint32, error) {
	var slotKey [36]byte
	binary.BigEndian.PutUint32(slotKey[:4], addressID)
	copy(slotKey[4:], slot[:])

	val, err := tx.Get(db.SlotIndex, slotKey[:])
	if err == nil {
		return binary.BigEndian.Uint32(val), nil
	}
	if !mdbx.IsNotFound(err) {
		return 0, err
	}

	counterKey := "slot_counter:" + string(slotKey[:4])
	id, err := getNextCounter(tx, db, counterKey)
	if err != nil {
		return 0, err
	}

	var buf [4]byte
	binary.BigEndian.PutUint32(buf[:], id)
	if err := tx.Put(db.SlotIndex, slotKey[:], buf[:], 0); err != nil {
		return 0, err
	}
	if err := setNextCounter(tx, db, counterKey, id+1); err != nil {
		return 0, err
	}
	return id, nil
}

func getNextCounter(tx *mdbx.Txn, db *DB, key string) (uint32, error) {
	val, err := tx.Get(db.Metadata, []byte(key))
	if err != nil {
		if mdbx.IsNotFound(err) {
			return 1, nil // default 1; 0 is reserved
		}
		return 0, err
	}
	return binary.BigEndian.Uint32(val), nil
}

func setNextCounter(tx *mdbx.Txn, db *DB, key string, val uint32) error {
	var buf [4]byte
	binary.BigEndian.PutUint32(buf[:], val)
	return tx.Put(db.Metadata, []byte(key), buf[:], 0)
}
