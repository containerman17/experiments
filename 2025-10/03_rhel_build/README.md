# AvalancheGo RHEL 8 vs 9 Build Test

Tests whether avalanchego v1.13.3 dropped RHEL 8 support and validates the fix.

## Run Tests

```bash
./test_builds.sh
```

## Results

| OS | Version | Result |
|---|---|---|
| RHEL 8 | v1.13.2 | ✓ |
| RHEL 8 | v1.13.3 | ✗ `undefined reference to dlsym` |
| RHEL 8 | v1.13.3 + fix | ✓ |
| RHEL 9 | v1.13.2 | ✓ |
| RHEL 9 | v1.13.3 | ✓ |

## Fix for RHEL 8

```bash
export CGO_LDFLAGS="-ldl"
./scripts/build.sh
```

See `FINDINGS.md` for details.
