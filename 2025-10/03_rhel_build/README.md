# AvalancheGo RHEL 8 vs 9 Build Test

Tests whether avalanchego v1.13.3 dropped RHEL 8 support by building v1.13.2 and v1.13.3 on both RHEL 8 and 9.

## Run Tests

```bash
./test_builds.sh
```

Results saved to `test_results/`.

## Result

RHEL 8 + v1.13.3 fails with linker errors:
```
undefined reference to `dlsym'
```

The `firewood-go-ethhash/ffi` dependency needs `-ldl` which RHEL 8's older linker doesn't add automatically. RHEL 9's newer linker handles it.

See `FINDINGS.md` for details and workaround.
