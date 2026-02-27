#!/usr/bin/env python3
"""Trace a transaction and report opcode frequency + gas breakdown."""

import json
import requests
import sys

RPC_URL = "http://localhost:9650/ext/bc/C/rpc"
TX_HASH = "0x1c1192036597a43b86923dfa3f2b92044563b5ac204422e20f3a603f0e82c77d"

# JS tracer that tracks gas via remaining-gas deltas between steps
TRACER = """
{
    counts: {},
    gasBy: {},
    prevGas: 0,
    prevOp: "",
    step: function(log) {
        var op = log.op.toString();
        var g = log.getGas();
        if (this.prevOp !== "") {
            var cost = this.prevGas - g;
            if (cost > 0) {
                this.gasBy[this.prevOp] = (this.gasBy[this.prevOp] || 0) + cost;
            }
        }
        this.counts[op] = (this.counts[op] || 0) + 1;
        this.prevGas = g;
        this.prevOp = op;
    },
    fault: function(log, db) {},
    result: function(ctx, db) {
        return { counts: this.counts, gasByOpcode: this.gasBy };
    }
}
"""

def main():
    tx_hash = sys.argv[1] if len(sys.argv) > 1 else TX_HASH

    print(f"Tracing {tx_hash} ...")
    resp = requests.post(RPC_URL, json={
        "jsonrpc": "2.0",
        "id": 1,
        "method": "debug_traceTransaction",
        "params": [tx_hash, {"tracer": TRACER.strip()}]
    }, timeout=300)

    data = resp.json()
    if "error" in data:
        print(f"RPC error: {json.dumps(data['error'], indent=2)}")
        sys.exit(1)

    result = data["result"]
    counts = result["counts"]
    gas = result["gasByOpcode"]

    total_gas = sum(v for v in gas.values() if v)
    total_ops = sum(counts.values())

    print(f"\nTotal opcodes executed: {total_ops:,}")
    print(f"Total tracked gas:     {total_gas:,}")

    # Full breakdown sorted by gas
    print(f"\n{'Opcode':<20} {'Count':>10} {'Total Gas':>15} {'Avg Gas':>10} {'% Gas':>7}")
    print("-" * 65)
    for op in sorted(gas, key=lambda x: gas[x] or 0, reverse=True):
        g = gas[op] or 0
        c = counts.get(op, 1)
        avg = g / c if c else 0
        pct = g / total_gas * 100 if total_gas else 0
        if pct < 0.1:
            continue  # skip noise
        print(f"{op:<20} {c:>10,} {g:>15,} {avg:>10,.0f} {pct:>6.1f}%")

    # Key opcodes
    print(f"\n{'='*50}")
    print("KEY OPCODES FOR REPRICING ANALYSIS")
    print(f"{'='*50}")
    targets = ["SSTORE", "CREATE", "CREATE2", "SLOAD", "CALL", "DELEGATECALL", "STATICCALL"]
    for target in targets:
        if target in counts:
            g = gas.get(target, 0) or 0
            c = counts[target]
            pct = g / total_gas * 100 if total_gas else 0
            print(f"  {target:<16} {c:>6,} calls  {g:>12,} gas  ({pct:.1f}%)")

if __name__ == "__main__":
    main()
