# Findings

## Result

RHEL 8 + v1.13.3 **FAILS** with linker errors. RHEL 9 works fine.

| OS | Version | Result | Error |
|----|---------|--------|-------|
| RHEL 8 | v1.13.2 | ✓ | - |
| RHEL 8 | v1.13.3 | ✗ | `undefined reference to dlsym` |
| RHEL 9 | v1.13.2 | ✓ | - |
| RHEL 9 | v1.13.3 | ✓ | - |

## Root Cause

The `firewood-go-ethhash/ffi` library (added in v1.13.3) links against Rust code that needs `libdl` for dynamic loading (`dlsym`).

**RHEL 8's GCC 8.5/LD 2.30** doesn't automatically link `-ldl` for static libraries.  
**RHEL 9's GCC 11.5/LD 2.35** handles this automatically.

The linker command is missing `-ldl` flag, causing:
```
undefined reference to `dlsym'
collect2: error: ld returned 1 exit status
```

## Conclusion

v1.13.3 effectively dropped RHEL 8 support due to the firewood dependency requiring newer linker behavior.

**Workaround**: Add `-ldl` to CGO_LDFLAGS before building on RHEL 8.
