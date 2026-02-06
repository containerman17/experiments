.PHONY: compile generate vet clean

compile:
	@mkdir -p build
	solc --abi --bin --optimize --optimize-runs 200 -o build/ --overwrite contracts/GasBurner.sol

generate: compile
	@mkdir -p bindings
	abigen --abi build/GasBurner.abi --bin build/GasBurner.bin \
		--pkg bindings --out bindings/gasburner.go --type GasBurner

vet: generate
	go vet ./...

clean:
	rm -rf build bindings
