package store

import "encoding/binary"

func BlockKey(num uint64) [8]byte {
	var key [8]byte
	binary.BigEndian.PutUint64(key[:], num)
	return key
}

func StorageKey(addr [20]byte, slot [32]byte) [52]byte {
	var key [52]byte
	copy(key[:20], addr[:])
	copy(key[20:], slot[:])
	return key
}

func HistoryKey(keyID uint64, shardMax uint64) [16]byte {
	var key [16]byte
	binary.BigEndian.PutUint64(key[:8], keyID)
	binary.BigEndian.PutUint64(key[8:], shardMax)
	return key
}

func KeyIDEncode(addressID uint32, slotID uint32) uint64 {
	return uint64(addressID)<<34 | uint64(slotID)
}

func KeyIDDecode(id uint64) (addressID uint32, slotID uint32) {
	addressID = uint32(id >> 34)
	slotID = uint32(id & 0x3FFFFFFFF)
	return
}

func KeyIDBytes(id uint64) [8]byte {
	var key [8]byte
	binary.BigEndian.PutUint64(key[:], id)
	return key
}

// AccountSentinelSlot is used as the slot key in the KeyDict for account-level entries.
// All 0xFF bytes — can never collide with a real storage slot (which has bit 0 of byte 0
// cleared by state key normalization).
var AccountSentinelSlot = [32]byte{
	0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
	0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
	0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
	0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
}
