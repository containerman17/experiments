# Token Override System

## Overview

This system provides state overrides for ERC20 token balances and allowances in `eth_call` requests. It enables testing and quoting without actual token ownership by manipulating contract storage slots.

## Purpose

When quoting token swaps using contracts like Hayabusa, we need tokens in specific addresses. Instead of actually transferring tokens, we use **state overrides** to temporarily set balances and allowances during the eth_call simulation.

## Critical Architecture Decision: Whale Address Pattern

**Problem**: Setting balance overrides directly on the Hayabusa contract breaks circular routes (e.g., USDC→WAVAX→USDt→USDC). When `tokenOut == tokenIn`, the `balanceOf(Hayabusa)` check returns the override value instead of actual balance, corrupting delta calculations.

**Solution**: Use a "whale" address pattern:
1. Set `token.balanceOf(whale)` = amount
2. Set `token.allowance(whale, hayabusa)` = amount  
3. Hayabusa pulls via `transferFrom(whale, hayabusa, amount)`

This keeps Hayabusa's actual balance at 0, making circular routes work correctly.

## Storage Slot Calculation

### Balance Storage Slots

ERC20 tokens store balances in various patterns:

#### 1. Standard Mapping (Most Common)
```solidity
mapping(address => uint256) balances;  // at storage slot N
```
**Slot calculation**: `keccak256(abi.encode(address, slotNumber))`

Example: USDC has balances at slot 9
```typescript
balanceSlot = keccak256(encode(account, 9))
```

#### 2. ERC-7201 Namespaced Storage
```solidity
// OpenZeppelin Upgradeable pattern
mapping(address => uint256) balances;  // at namespaced location
```
**Slot calculation**: `keccak256(abi.encode(address, baseHash))`

Example base: `0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00`

#### 3. Packed ERC-7201 (Rare)
Some tokens pack balance with flags:
```solidity
struct BalanceData {
    bool frozen;
    uint248 balance;
}
```
**Value must be shifted**: `balanceValue << 8`

### Allowance Storage Slots

Allowances use **nested mappings**:
```solidity
mapping(address owner => mapping(address spender => uint256)) allowances;
```

**Slot calculation** (two-step keccak256):
```typescript
innerHash = keccak256(encode(owner, allowanceBaseSlot))
allowanceSlot = keccak256(encode(spender, innerHash))
```

**Default pattern**: If balance is at slot N, allowance is typically at slot N+1.

**Exceptions exist**: Some tokens use different offsets (e.g., allowance at slot 0, balance at slot 1).

## Token Configuration Format

### `supported_tokens.json` Schema

#### Standard Token
```json
{
  "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e": {
    "slot": 9
  }
}
```
- `slot`: Balance mapping slot number
- Allowance automatically calculated at `slot + 1`

#### Token with Custom Allowance Slot
```json
{
  "0x60781c2586d68229fde47564546784ab3faca982": {
    "slot": 1,
    "allowanceSlot": 0
  }
}
```
- `allowanceSlot`: Override default allowance slot location

#### ERC-7201 Token
```json
{
  "0xe1bfc96d95badcb10ff013cb0c9c6c737ca07009": {
    "base": "0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00"
  }
}
```
- `base`: ERC-7201 namespace hash
- Allowance uses same base by default

#### Packed ERC-7201 Token
```json
{
  "0x00000000efe302beaa2b3e6e1b18d08d69a9012a": {
    "base": "0x455730fed596673e69db1907be2e521374ba893f1a04cc5f5dd931616cd6b700",
    "shift": 8
  }
}
```
- `shift`: Bit shift for packed storage (e.g., bool + uint248)

## Key Files

### Core Implementation

- **`getOverride.ts`**: Main API - computes state override objects
  - Exports: `getOverride(token, account, balance, spender?)` 
  - Returns: `{ [tokenAddress]: { stateDiff: { [slot]: value } } }`

- **`supported_tokens.json`**: Token configuration database
  - 72 tokens with known balance + allowance slots
  - Tokens without working overrides are excluded

### Discovery Tools

- **`study.ts`**: Discover balance slot for a new token
  - Tests known slots (0-500) and ERC-7201 bases
  - Detects rebasing tokens (balance != expected)
  - Usage: `node study.ts <token_address>`

- **`studyAllowance.ts`**: Discover allowance slot for a token
  - Requires known balance configuration
  - Tests offset ranges and alternate bases
  - Usage: `node studyAllowance.ts <token> <balance_slot_or_base> [shift]`

### Verification Tools

- **`checkOverrides.ts`**: Verify all configured tokens
  - Tests BOTH balance AND allowance overrides
  - Reports pass/fail for each token
  - Exit code 1 if any failures
  - Usage: `node checkOverrides.ts`

## Adding a New Token

### Step 1: Discover Balance Slot

Run the balance slot discovery:
```bash
node ./pkg/overrides/study.ts 0xTOKEN_ADDRESS
```

**Outcomes**:
- ✅ **Found at slot N**: Standard token, use `{ "slot": N }`
- ✅ **Found with ERC-7201 base**: Use `{ "base": "0x..." }`  
- ✅ **Found with shift**: Packed token, use `{ "base": "0x...", "shift": 8 }`
- ❌ **Not found**: Token uses non-standard storage (skip for now)

### Step 2: Add to Configuration

Add the discovered configuration to `supported_tokens.json`:
```json
{
  "0xtoken_address_lowercase": {
    "slot": 9
  }
}
```

### Step 3: Test Balance Override

```bash
node ./pkg/overrides/checkOverrides.ts
```

Check if your token passes the balance check. If it fails, verify the slot number.

### Step 4: Discover Allowance Slot (If Balance Fails)

If balance works but allowance fails, discover the allowance slot:

**For standard tokens**:
```bash
node ./pkg/overrides/studyAllowance.ts 0xTOKEN 9
```

**For ERC-7201 tokens**:
```bash
node ./pkg/overrides/studyAllowance.ts 0xTOKEN 0x52c63...bace00
```

**For packed tokens**:
```bash
node ./pkg/overrides/studyAllowance.ts 0xTOKEN 0x4557...6b700 8
```

### Step 5: Apply Allowance Fix (If Needed)

If allowance slot differs from default `slot+1`, update configuration:
```json
{
  "0xtoken_address": {
    "slot": 1,
    "allowanceSlot": 0
  }
}
```

### Step 6: Final Verification

```bash
node ./pkg/overrides/checkOverrides.ts
```

Both balance AND allowance must pass (✅).

## Known Limitations

**Unsupported Token Types**:
- Tokens with non-discoverable allowance slots (29 tokens removed)
- Tokens using custom storage layouts requiring `debug_traceTransaction`
- Fee-on-transfer tokens (override shows balance, but transfer reduces it)
- Rebasing tokens (balance changes unpredictably)

**Current Status**:
- ✅ 72 tokens fully supported (balance + allowance)
- ❌ 29 tokens excluded (allowance discovery failed)
- Total discovered: 101 tokens

## ERC-7201 Known Bases

```typescript
// OpenZeppelin ERC20Upgradeable
'0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00'

// Agora USD (AUSD)
'0x455730fed596673e69db1907be2e521374ba893f1a04cc5f5dd931616cd6b700'
```

## Usage in Code

```typescript
import { getOverride } from './pkg/overrides/getOverride.ts'

// For circular routes (whale pattern)
const whale = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
const hayabusa = '0xHAYABUSA_ADDRESS'

const override = getOverride(
  tokenAddress,
  whale,           // funding address
  amountIn,
  hayabusa         // spender (receives allowance)
)

// Use in eth_call
const result = await client.request({
  method: 'eth_call',
  params: [
    { to: hayabusa, data: quoteCallData },
    'latest',
    override  // Apply state override
  ]
})
```

## Maintenance Notes

**When allowance checks fail**:
1. Check if token's allowance mapping is at a different slot
2. Run `studyAllowance.ts` to discover correct slot
3. Update `supported_tokens.json` with `allowanceSlot` field
4. Re-verify with `checkOverrides.ts`

**When adding many tokens**:
1. Use `study.ts` for balance discovery
2. Add all to `supported_tokens.json`
3. Run `checkOverrides.ts`
4. Remove failing tokens or fix with `allowanceSlot` config
5. Maintain 100% pass rate

**Backup**: `supported_tokens_backup.json` contains full 101-token config before cleanup.
