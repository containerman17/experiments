.PHONY: generate vet clean

generate:
	go run generate_variants.go

vet: generate
	go vet ./...

clean:
	rm -rf build bindings burner/variants.go
