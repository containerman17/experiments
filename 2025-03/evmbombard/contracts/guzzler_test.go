package contracts

import (
	"encoding/hex"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestGetCPUPayloadData(t *testing.T) {
	payload := GetCPUPayloadData(1)
	require.Equal(t, "510b45e30000000000000000000000000000000000000000000000000000000000000001", hex.EncodeToString(payload))

	payload = GetCPUPayloadData(99999999999)
	require.Equal(t, "510b45e3000000000000000000000000000000000000000000000000000000174876e7ff", hex.EncodeToString(payload))
}
