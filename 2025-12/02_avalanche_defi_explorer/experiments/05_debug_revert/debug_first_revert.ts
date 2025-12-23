// experiments/05_debug_revert/debug_first_revert.ts
// This script uses the debug RPC endpoint to trace the first revert observed in the quote_wavax experiment.
// It demonstrates how to call `debug_traceCall` with the same call data and state overrides.

import { getRpcUrl } from '../../pkg/rpc';
import { createPublicClient, http, parseAbi } from 'viem';

// Top‑level await is used as per project conventions.

// RPC URL (debug node) from environment
const rpcUrl = getRpcUrl();

// Create a viem public client with the debug RPC URL.
const client = createPublicClient({
    transport: http(rpcUrl),
});

// ---------------------------------------------------------------------------
// Parameters for the first revert (uniswap_v3 pool 0x11476e10...)
// ---------------------------------------------------------------------------
const from = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const to = '0x38cb6c987996ac24a3a0945557e15ca2a71d4300'; // Router contract used in the quote script
const data =
    '0x4d8a9dda' + // function selector for quoteExactInputSingle
    '0000000000000000000000000000000000000000000000000000000000000080' + // amountIn = 10 USDC (0x...?) – placeholder
    '0000000000000000000000000000000000000000000000000000000000000000' + // padding
    '00000000000000000000000000000000000000000000000000000000000000c0' + // offset to calldata
    '0000000000000000000000000000000000000000000000000000000000000100' + // length of path (1 address?) – placeholder
    '0000000000000000000000000000000000000000000000000000000000000f4240' + // amountOutMinimum (1,000,000?) – placeholder
    '0000000000000000000000000000000000000000000000000000000000000010' + // deadline – placeholder
    '0000000000000000000000000000000000000000000000000000000000000000' + // sqrtPriceLimitX96 – placeholder
    // The actual calldata from the log (truncated for brevity)
    '000000000000000000000000011476e10eb79ddffa6f2585be526d2bd840c3e20000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002000000000000000000000000b97ef9ef8734c71904d8002f8b6bc66dd9c48a6e000000000000000000000000b31f66aa3c1e785363f0875a1b74e27b85fd66c7';

// State override used in the original call (only the relevant slot is shown)
const stateOverrides = {
    '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e': {
        stateDiff: {
            '0x2e8fc2111bcace290b8f5e428b9be228f934229482dcdb0d1e9bbb114290b1c0':
                '0x00000000000000000000000000000000000000000000000000000000000f4240',
        },
    },
};

// Perform the debug trace call
const trace = await client.request({
    method: 'debug_traceCall',
    params: [
        {
            from,
            to,
            data,
            stateOverrides,
        },
        'latest', // block tag
        { tracer: 'callTracer', timeout: '30s' }, // optional tracer config
    ],
});

console.log('Debug trace result for the first revert:');
console.dir(trace, { depth: null });
