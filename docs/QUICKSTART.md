# Quick Start Guide

Get the Ajuna Token Swap system running on your local machine in under 10 minutes.

---

## Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| **Node.js** | v22+ | Runtime & tooling |
| **npm** | v10+ | Package manager |
| **Git** | any | Clone the repository |
| **Rust** | stable + nightly | Build the local dev node (optional) |

> **Note**: The Rust toolchain is only required if you want PVM integration testing (Level 2+). For unit tests (Level 1), Node.js is sufficient.

---

## 1. Clone & Install

```bash
git clone <repository-url>
cd ajuna-tokenswap
npm install --legacy-peer-deps
```

The `--legacy-peer-deps` flag is required because `@parity/hardhat-polkadot` has peer dependency constraints that conflict with newer Hardhat versions.

---

## 2. Compile Contracts

```bash
npx hardhat compile
```

This uses `@parity/resolc` to compile Solidity → RISC-V bytecode for `pallet-revive`. On first run it may download the compiler binary.

Expected output:
```
Compiled 27 Solidity files successfully (using solc 0.8.28 and target revive).
Generating typings for: 27 artifacts in dir: typechain-types for target: ethers-v6
Successfully generated 106 typings!
```

---

## 3. Run Unit Tests

```bash
npm test
# or
npx hardhat test
```

This runs all 112 tests in Hardhat's in-memory EVM — no local node required:

```
  AjunaWrapper System
    Deployment (6 tests)
    Deposit / Wrap (4 tests)
    Withdraw / Unwrap (5 tests)
    Access Control (4 tests)
    Pausable (4 tests)
    Rescue (4 tests)
    Multi-User (1 test)
    UUPS Upgradeability (13 tests)
    Ownership Transfer (4 tests)
    Role Management (3 tests)
    Rescue Edge Cases (3 tests)
    Pause Edge Cases (2 tests)
    Zero-Amount Edge Cases (3 tests)
    Reentrancy Protection (1 test)
    Event Validation (4 tests)

  112 passing
```

If all 112 tests pass, the Solidity logic is verified. You're ready to move to integration testing.

---

## 4. Start a Local Dev Node (Optional)

For PVM integration testing against a real Polkadot-compatible runtime:

### 4a. Build the Node (first time only)

```bash
./scripts/setup_node.sh
```

This compiles `revive-dev-node` and `eth-rpc` from the `polkadot-sdk/` subtree. Takes 15–30 minutes depending on hardware.

### 4b. Run the Node

```bash
./scripts/run_local_node.sh
```

This starts two processes:
- **revive-dev-node** — Substrate node with `pallet-revive`
- **eth-rpc** — Ethereum JSON-RPC adapter on `http://127.0.0.1:8545`

The node comes with **Alith** pre-funded (`0xf24FF3a9CF04c71Dbc94D0b566f7A27B94566cac`).

### 4c. Full Automated E2E Pipeline

In a separate terminal:

```bash
./scripts/e2e_local.sh
```

This script automatically:
1. Verifies node connectivity
2. Deploys a mock Foreign Asset (ERC20)
3. Deploys AjunaERC20 + AjunaWrapper (both behind UUPS proxies)
4. Runs the full wrap → unwrap E2E integration test

---

## 5. Test in Browser (Optional)

### Developer Testing UI

```bash
./scripts/serve_ui.sh
```

Open http://localhost:8000/test-ui.html and paste in the contract addresses printed by the E2E pipeline.

**Workflow:**
1. Click **Fund Test Account** (gets 100 DEV from Alith)
2. **Approve Foreign Asset** → **Deposit** (wrap AJUN → wAJUN)
3. **Approve wAJUN** → **Withdraw** (unwrap wAJUN → AJUN)

### User-Facing dApp

Open with contract addresses as URL parameters:

```
http://localhost:8000/app.html?wrapper=0x...&erc20=0x...&foreign=0x...
```

This dApp connects to MetaMask/SubWallet/Talisman for wallet-based testing.

---

## 6. Next Steps

| Goal | Document |
|------|----------|
| Deploy to testnet or production | [DEPLOYMENT.md](DEPLOYMENT.md) |
| Understand the contract architecture | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Learn about security features | [SECURITY.md](SECURITY.md) |
| Upgrade deployed contracts | [UPGRADE.md](UPGRADE.md) |
| Integrate the contracts in your app | [USAGE.md](USAGE.md) |

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Compilation errors | `npx hardhat clean && npm install --legacy-peer-deps && npx hardhat compile` |
| `revive-dev-node` not found | Run `./scripts/setup_node.sh` to build the node |
| Dependency conflicts | Use `npm install --legacy-peer-deps` |
| Tests fail with gas errors | Ensure `hardhat.config.ts` uses Solidity 0.8.28 |
| Node unreachable at 8545 | Check that both `revive-dev-node` and `eth-rpc` are running |
| Wrong decimals in UI | AJUN uses 12 decimals, not 18. Use `parseUnits(x, 12)` |
