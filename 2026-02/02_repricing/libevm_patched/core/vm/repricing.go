package vm

import "github.com/ava-labs/libevm/params"

var (
	repricedSstoreSetGasEIP2200 uint64 = params.SstoreSetGasEIP2200
	repricedCreate2Gas          uint64 = params.Create2Gas
)

// SetReplayGasSchedule overrides selected opcode costs for replay experiments.
// A value of 0 keeps the canonical default.
func SetReplayGasSchedule(sstoreSetGasEIP2200 uint64, create2Gas uint64) {
	if sstoreSetGasEIP2200 == 0 {
		repricedSstoreSetGasEIP2200 = params.SstoreSetGasEIP2200
	} else {
		repricedSstoreSetGasEIP2200 = sstoreSetGasEIP2200
	}
	if create2Gas == 0 {
		repricedCreate2Gas = params.Create2Gas
	} else {
		repricedCreate2Gas = create2Gas
	}
}

func replaySstoreSetGasEIP2200() uint64 {
	return repricedSstoreSetGasEIP2200
}

func replayCreate2ExtraGas() uint64 {
	if repricedCreate2Gas <= params.Create2Gas {
		return 0
	}
	return repricedCreate2Gas - params.Create2Gas
}
