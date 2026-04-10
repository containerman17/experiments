package mdbxethdb

import "github.com/erigontech/mdbx-go/mdbx"

func isNotFound(err error) bool {
	return mdbx.IsNotFound(err)
}
