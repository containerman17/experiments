#! /bin/bash

cd $(dirname $0)

# Create the bin directory if it doesn't exist
mkdir -p bin

# Build the go test setup
go build -o bin/go_test_setup ./cmd/prepare_test/
go build -o bin/go_generate_keys ./cmd/generate_keys/