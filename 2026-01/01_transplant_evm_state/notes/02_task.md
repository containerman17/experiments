# EVM State Transplant Test Suite

## Goal
Create a set of bash scripts to test transplanting EVM state between two L1 chains.

## Steps

### 1. Create Primary Network
Bootstrap a local Avalanche network with 3 nodes using predefined node IDs (each node must have its own unique identity).

### 2. Create L1
Deploy an L1 chain with 3 validator nodes on top of the primary network.

### 3. Populate State
Fill the L1 with test data:
- Option A: Deploy a contract and write some values
- Option B: Simple transfers (e.g., send 1-2 coins to the zero address)

### 4. Shutdown Source Network
Stop all 6 nodes (3 primary network + 3 L1 validators).

### 5. Create New Network
Bootstrap a fresh primary network (3 nodes) and a new L1 (3 nodes).

### 6. Transplant State
Copy the state data from the old L1 to the new L1.

### 7. Verification Script
A separate bash script that checks the expected address has the expected balance, proving the state was ported correctly.

---

## Open Questions / Things to Check

- [ ] **Single node bootstrap?** - Can Avalanche bootstrap with just 1 node? Need to verify in avalanche-go repository the minimum validator count.
- [ ] **Node ID handling** - Use predefined node IDs for deterministic behavior across test runs.
- [ ] **Test data approach** - Decide between contract deployment vs simple transfers for populating state.
