# Findings

## Result

RHEL 8 + v1.13.3 **FAILS** with linker errors. RHEL 9 works fine. **Fix: add `-ldl` to CGO_LDFLAGS.**

| OS | Version | Result | Notes |
|----|---------|--------|-------|
| RHEL 8 | v1.13.2 | ✓ | - |
| RHEL 8 | v1.13.3 | ✗ | `undefined reference to dlsym` |
| RHEL 8 | v1.13.3 + fix | ✓ | With `CGO_LDFLAGS="-ldl"` |
| RHEL 9 | v1.13.2 | ✓ | - |
| RHEL 9 | v1.13.3 | ✓ | - |

## Root Cause

The `firewood-go-ethhash/ffi` library (added in v1.13.3) links against Rust code that needs `libdl` for dynamic loading (`dlsym`).

**RHEL 8's GCC 8.5/LD 2.30** doesn't automatically link `-ldl` for static libraries.  
**RHEL 9's GCC 11.5/LD 2.35** handles this automatically.

## Fix for RHEL 8

Add before building:
```bash
export CGO_LDFLAGS="-ldl"
```

Or in the Dockerfile:
```dockerfile
ENV CGO_LDFLAGS="-ldl"
```

## Conclusion

v1.13.3 effectively dropped RHEL 8 support without the workaround. The fix is simple but must be explicitly applied.
