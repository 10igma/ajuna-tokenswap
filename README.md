# Ajuna Tokenswap

[![CI](https://github.com/10igma/ajuna-tokenswap/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/10igma/ajuna-tokenswap/actions/workflows/ci.yml)

A smart contract system to transform AJUN Foreign Assets into ERC20 tokens (wAJUN) on Polkadot AssetHub using `pallet-revive`.

## Overview

This project implements a treasury-based token wrapper that:
- Locks AJUN Foreign Assets in a treasury contract (`AjunaWrapper`)
- Mints equivalent ERC20 tokens (`AjunaERC20` / wAJUN) to users
- Allows users to burn wAJUN (via standard ERC20 approval) to withdraw their locked Foreign Assets
- Uses role-based access control (`MINTER_ROLE`) for secure mint/burn operations
- Includes a pausable circuit breaker, token rescue, and upgradeable foreign asset address
- **UUPS proxy upgradeability** — both contracts can be upgraded without migrating state

## ✅ Foreign Assets ERC20 Precompile — Ready

> **Status: Resolved — [paritytech/polkadot-sdk#10869](https://github.com/paritytech/polkadot-sdk/pull/10869) merged and deployed**

The Polkadot AssetHub runtime now exposes ERC20 precompiles for **Foreign Assets** via the `ForeignAssetIdExtractor`. Each foreign asset (keyed by `xcm::v5::Location`) is assigned a sequential `u32` index, and its ERC20 precompile is accessible at a deterministic address with prefix `0x0220`.

AJUN is registered on AssetHub as a Foreign Asset at `Location { parents: 1, interior: X1(Parachain(2051)) }`.

**To discover the precompile address:**
```bash
npx ts-node scripts/lookup_ajun_asset.ts
```

This queries the `AssetsPrecompiles` pallet storage:
- `foreignAssetIdToAssetIndex(Location)` → `u32` index
- Precompile address = `computePrecompileAddress(index, 0x0220)`

**No Solidity code changes were required** — the contracts were designed to work with any ERC20-compatible address, and the precompile implements the same `IERC20` interface as the mock contracts used in testing.

## Architecture

```
┌─────────────────┐
│ IERC20Precompile│ ← Interface to Foreign Asset precompile
└─────────────────┘
         ↑
         │ transferFrom / transfer
┌──────────────────┐      mint / burnFrom      ┌──────────────┐
│  AjunaWrapper    │────────────────────────→  │  AjunaERC20  │
│   (Treasury)     │                           │   (wAJUN)    │
│   Ownable        │                           │ AccessControl│
│   Pausable       │                           │ UUPS Proxy   │
│   ReentrancyGuard│                           └──────────────┘
│   UUPS Proxy     │
└──────────────────┘
```

Both contracts are deployed behind ERC1967 proxies (UUPS pattern), enabling
logic upgrades while preserving all state (balances, roles, locked assets).

### Contracts

- **`IERC20Precompile.sol`**: Interface for the Foreign Asset precompile (ERC20-compatible)
- **`AjunaERC20.sol`**: UUPS-upgradeable wrapped AJUN ERC20 token with configurable decimals and role-gated `mint()` / `burnFrom()`. Upgrades restricted to `UPGRADER_ROLE`.
- **`AjunaWrapper.sol`**: UUPS-upgradeable treasury contract — Pausable, with rescue, foreign asset address update, and reentrancy guard. Upgrades restricted to `onlyOwner`.
- **`Proxy.sol`**: Imports OpenZeppelin's `ERC1967Proxy` to make it available for deployment scripts.

## Prerequisites

- Node.js v22+ and npm
- Git

## Installation

```bash
git clone <repository-url>
cd ajuna-tokenswap
npm install --legacy-peer-deps
```

## Project Structure

```
ajuna-tokenswap/
├── contracts/
│   ├── AjunaERC20.sol           # ERC20 wrapper token (wAJUN) — UUPS upgradeable
│   ├── AjunaWrapper.sol         # Treasury contract — UUPS upgradeable
│   ├── Proxy.sol                # Imports ERC1967Proxy for deployment
│   └── interfaces/
│       └── IERC20Precompile.sol # Foreign Asset interface
├── test/
│   └── wrapper.test.ts          # Comprehensive test suite (119 tests)
├── scripts/
│   ├── setup_node.sh            # Build revive-dev-node
│   ├── run_local_node.sh        # Run local PVM node
│   ├── deploy_testnet.sh        # Deploy to testnet
│   ├── deploy_production.sh     # Deploy to production (mainnet)
│   ├── deploy_mock_foreign_asset.ts # Deploy mock FA for local testing
│   ├── e2e_test.ts              # E2E integration test script
│   ├── e2e_local.sh             # Full automated E2E pipeline
│   ├── lookup_ajun_asset.ts     # Query AJUN asset on live chain
│   └── serve_ui.sh              # Serve the UIs
├── deployments.config.ts        # Multi-environment configuration
├── chopsticks.yml               # Chopsticks fork config (AssetHub)
├── frontend/
│   ├── app.html                 # User-facing swap dApp (MetaMask)
│   └── test-ui.html             # Developer testing interface
├── hardhat.config.ts            # Hardhat configuration
└── README.md
```

## Configuration

The project is configured in `hardhat.config.ts` with three networks plus the default in-memory network:

| Network | Chain ID | Purpose |
|---------|----------|---------|
| `hardhat` (default) | — | In-memory testing |
| `local` | 420420420 | Local `revive-dev-node` |
| `polkadotTestnet` | 420420417 | Polkadot Hub TestNet |
| `polkadotMainnet` | 420420419 | Polkadot AssetHub Production |

## Testing

### Run Tests

```bash
npm test
# or
npx hardhat test
```

Expected output:
```
  AjunaWrapper System
    Deployment
      ✔ should set correct token and foreignAsset addresses
      ✔ should set correct decimals
      ✔ should revert AjunaERC20 initialization with zero admin
      ✔ should revert AjunaWrapper initialization with zero token address
      ✔ should revert AjunaWrapper initialization with zero precompile address
    Deposit (Wrap)
      ✔ should wrap Foreign Assets and emit Deposited event
      ✔ should revert on zero amount
      ✔ should revert without prior approval
      ✔ should maintain invariant after multiple deposits
    Withdraw (Unwrap)
      ✔ should unwrap ERC20 tokens and emit Withdrawn event
      ✔ should revert on zero amount
      ✔ should revert with insufficient ERC20 balance
      ✔ should revert without ERC20 approval (burnFrom requires allowance)
      ✔ should maintain invariant after full unwrap
    Access Control
      ✔ should prevent non-MINTER from calling mint
      ✔ should prevent non-MINTER from calling burnFrom
      ✔ deployer should NOT have MINTER_ROLE by default
      ✔ wrapper should have MINTER_ROLE
    Pausable
      ✔ should reject deposit when paused
      ✔ should reject withdraw when paused
      ✔ should resume after unpause
      ✔ should only allow owner to pause/unpause
    Rescue
      ✔ should rescue accidentally sent tokens
      ✔ should NOT allow rescuing the locked foreign asset
      ✔ should only allow owner to rescue
    Multi-User
      ✔ should handle interleaved wrap/unwrap from two users
    UUPS Upgradeability
      ✔ should prevent re-initialization of AjunaERC20
      ✔ should prevent re-initialization of AjunaWrapper
      ✔ should prevent non-upgrader from upgrading AjunaERC20
      ✔ should prevent non-owner from upgrading AjunaWrapper
      ✔ should allow owner to upgrade AjunaERC20
      ✔ should allow owner to upgrade AjunaWrapper
      ✔ should preserve balances after AjunaWrapper upgrade
      ✔ should prevent calling initialize on implementation directly

  119 passing
```

### Test Coverage

The suite covers:
- **Deployment**: Constructor validation, address(0) rejection, decimals
- **Deposit (Wrap)**: Happy path, zero amount, missing approval, backing invariant
- **Withdraw (Unwrap)**: Happy path (with ERC20 approval), zero amount, insufficient balance, missing approval, backing invariant
- **Access Control**: MINTER_ROLE enforcement, deployer has no mint rights
- **Pausable**: Circuit breaker on/off for both deposit and withdraw; double-pause/unpause edge cases
- **Rescue**: Token rescue works; locked foreign asset cannot be rescued; wAJUN cannot be rescued; owner-only
- **Multi-User**: Interleaved operations maintain 1:1 backing invariant
- **UUPS Upgradeability**: Re-initialization blocked, unauthorized upgrade blocked, successful upgrade preserves state, implementation initializer disabled, EOA upgrade rejected
- **Ownership Transfer**: Two-step transfer, renounce blocked
- **Role Management**: Grant/revoke MINTER_ROLE, UPGRADER_ROLE
- **Edge Cases**: Zero-amount operations, reentrancy protection, event emission validation

### Testing Strategy: Local → Testnet → Production

The project uses a layered testing approach because the local dev node and production AssetHub have different runtime capabilities:

| Level | Environment | Foreign Asset | Precompile | Best For |
|-------|-------------|--------------|------------|----------|
| **1. Unit** | Hardhat in-memory EVM | Mock ERC20 | No | Contract logic, 119 tests |
| **2. PVM Integration** | Local `revive-dev-node` | Mock ERC20 | No | PVM bytecode compat, gas |
| **3. Chopsticks Fork** | Forked AssetHub state | **Real** | **Yes** | Production-like testing |
| **4. Testnet** | Polkadot Hub TestNet | **Real** (via XCM) | **Yes** | Full production path |
| **5. Production** | Polkadot AssetHub | **Real** (via XCM) | **Yes** | Live mainnet |

#### Why the levels differ

The local `revive-dev-node` runtime does **not** include `pallet-assets` or `pallet-foreign-assets`. It only has: System, Timestamp, Balances, Sudo, TransactionPayment, and Revive — with **zero precompiles** registered. This means there is no real ERC20 precompile address on the local dev node.

For Levels 1 and 2, we deploy a second `AjunaERC20` contract as a **mock foreign asset**. This exercises all the Solidity logic identically (ERC20 `approve` → `transferFrom`) since the precompile's ERC20 interface is the same as a standard ERC20.

For Levels 3 and 4, the real `pallet-assets` precompile is available at a deterministic address.

#### Precompile Address Calculation

Each asset on AssetHub gets a deterministic ERC20 precompile address:

```
Address (20 bytes) = [assetId (4B BE)] [zeros (12B)] [prefix (2B BE)] [0x0000]
```

- Native assets prefix: `0x0120`
- Foreign assets prefix: `0x0220` (confirmed — `ForeignAssetIdExtractor`)
- Example: Asset ID 1984 (USDT) → `0x000007C000000000000000000000000001200000`

Use the helper to compute any address:
```bash
npx ts-node -e "import {computePrecompileAddress} from './deployments.config'; console.log(computePrecompileAddress(1984))"
```

#### Level 2: Local PVM Integration Test

Full automated E2E pipeline on the local dev node:

```bash
# 1. Start the node (in a separate terminal)
./scripts/run_local_node.sh

# 2. Run the full pipeline (deploy mock FA + contracts + E2E test)
./scripts/e2e_local.sh
```

Or step-by-step:
```bash
npx hardhat run scripts/fund_account.ts --network local
npx hardhat run scripts/deploy_mock_foreign_asset.ts --network local
FOREIGN_ASSET=<MOCK_FA_ADDRESS> npx hardhat run scripts/deploy_wrapper.ts --network local
WRAPPER_ADDRESS=0x... ERC20_ADDRESS=0x... FOREIGN_ASSET=0x... \
  npx hardhat run scripts/e2e_test.ts --network local
```

#### Level 3: Chopsticks (Fork Real AssetHub)

[Chopsticks](https://github.com/AcalaNetwork/chopsticks) forks a live chain's state, giving you the **real runtime** including all registered foreign assets and precompile addresses.

```bash
# 1. Start Chopsticks fork of AssetHub
npx @acala-network/chopsticks --config=chopsticks.yml

# 2. Start the eth-rpc adapter (points to Chopsticks WS at port 8000)
./polkadot-sdk/target/release/eth-rpc --node-rpc-url ws://127.0.0.1:8000

# 3. Fund your test account via dev_setStorage (see chopsticks.yml for examples)

# 4. Deploy and test
FOREIGN_ASSET=<REAL_PRECOMPILE_ADDRESS> npx hardhat run scripts/deploy_wrapper.ts --network local
```

#### Level 4: Testnet Deployment

```bash
# 1. Look up AJUN foreign asset on testnet
npx ts-node scripts/lookup_ajun_asset.ts wss://westend-asset-hub-rpc.polkadot.io

# 2. Deploy
./scripts/deploy_testnet.sh

# 3. E2E test
WRAPPER_ADDRESS=0x... ERC20_ADDRESS=0x... FOREIGN_ASSET=0x... \
  npx hardhat run scripts/e2e_test.ts --network polkadotTestnet
```

#### Production Preparation Checklist

Before going to mainnet, verify:

- [ ] **AJUN is registered** as a foreign asset on AssetHub (query with `scripts/lookup_ajun_asset.ts`)
- [ ] **Precompile index assigned** — `assetsPrecompiles.foreignAssetIdToAssetIndex` returns a value
- [ ] **Precompile address computed** — `computePrecompileAddress(index, 0x0220)`
- [ ] **Decimals match** — AJUN native has 12 decimals, `AjunaERC20` must use 12
- [ ] **E2E passed on Chopsticks** with real precompile address
- [ ] **E2E passed on testnet** with real XCM-transferred AJUN
- [ ] **Existential Deposit** sent to Wrapper contract (0.1 DOT via substrate extrinsic)
- [ ] **Wrapper seeded** with small AJUN deposit to keep asset account alive
- [ ] **Admin roles** transferred to multisig and deployer role renounced
- [ ] **`frontend/app.html` CONFIG** updated with final contract addresses
- [ ] **dApp tested** via MetaMask on the target network

#### Level 5: Production Deployment

```bash
# 1. Look up AJUN precompile address
npx ts-node scripts/lookup_ajun_asset.ts

# 2. Deploy (interactive confirmation)
FOREIGN_ASSET=0x... ./scripts/deploy_production.sh

# 3. E2E test
WRAPPER_ADDRESS=0x... ERC20_ADDRESS=0x... FOREIGN_ASSET=0x... \
  npx hardhat run scripts/e2e_test.ts --network polkadotMainnet
```

### User-Facing Swap dApp (`frontend/app.html`)

A guided, wallet-connected dApp for end users to wrap and unwrap AJUN tokens.

#### Prerequisites

- A browser wallet: [MetaMask](https://metamask.io), [SubWallet](https://www.subwallet.app), or [Talisman](https://www.talisman.xyz) (EVM mode)
- Your wallet must be connected to the correct AssetHub network (local or testnet)
- You must have AJUN Foreign Assets on AssetHub (transferred via XCM from Ajuna Network)

#### Quick Start

1. **Deploy the contracts** (if not already deployed):
   ```bash
   ./scripts/e2e_local.sh
   ```
2. **Start the UI server**:
   ```bash
   ./scripts/serve_ui.sh
   ```
3. **Open in browser** with contract addresses as URL parameters:
   ```
   http://localhost:8000/app.html?wrapper=0x...&erc20=0x...&foreign=0x...
   ```
   Or edit the `CONFIG` object at the top of the `<script>` section in `frontend/app.html`.

4. **Connect your wallet** — click "Connect Wallet" and approve in MetaMask

#### Swap Workflow

**Wrap (AJUN → wAJUN):**
1. Enter the amount of AJUN you want to wrap
2. Click **"Approve AJUN"** — this grants the Wrapper contract permission to pull your AJUN tokens
3. Confirm the approval transaction in your wallet
4. Click **"Wrap → Receive wAJUN"** — this locks your AJUN and mints wAJUN to your address
5. Confirm the wrap transaction in your wallet

**Unwrap (wAJUN → AJUN):**
1. Switch to the "Unwrap" tab
2. Enter the amount of wAJUN you want to unwrap
3. Click **"Approve wAJUN"** — this grants the Wrapper contract permission to burn your wAJUN
4. Confirm the approval transaction in your wallet
5. Click **"Unwrap → Receive AJUN"** — this burns your wAJUN and releases the locked AJUN back to you
6. Confirm the unwrap transaction in your wallet

#### Configuring the Network in MetaMask

To add the Polkadot AssetHub network to MetaMask:

| Field | Local Dev Node | Polkadot Hub TestNet | Polkadot AssetHub (Production) |
|-------|---------------|---------------------|-------------------------------|
| Network Name | AssetHub Local | AssetHub TestNet | Polkadot AssetHub |
| RPC URL | `http://127.0.0.1:8545` | `https://services.polkadothub-rpc.com/testnet` | `https://eth-rpc.polkadot.io/` |
| Chain ID | `420420420` | `420420417` | `420420419` |
| Block Explorer | n/a | n/a | `https://blockscout.polkadot.io/` |
| Currency Symbol | `DOT` | `DOT` | `DOT` |

### Developer Testing UI (`frontend/test-ui.html`)

For interactive developer testing on a local node (uses hardcoded test accounts):

1. **Start the local node**: `./scripts/run_local_node.sh`
2. **Deploy contracts**: `./scripts/e2e_local.sh` (or step-by-step: `deploy_mock_foreign_asset.ts` + `deploy_wrapper.ts`)
3. **Start the test UI server**: `./scripts/serve_ui.sh`
4. **Open in browser**: http://localhost:8000/test-ui.html
5. Paste the wrapper, ERC20, and foreign asset addresses, then click "Load Contracts"

**Workflow**:
1. Click "Fund Test Account" to get 100 DEV from Alice
2. **Approve Foreign Asset** → **Deposit** (wrap)
3. **Approve ERC20 (wAJUN)** → **Withdraw** (unwrap)
4. Watch balances and treasury invariant update in real-time

## Usage Example

### Wrap Foreign Assets (Deposit)

```javascript
const wrapper = await ethers.getContractAt("AjunaWrapper", wrapperAddress);
const foreignAsset = new ethers.Contract(precompileAddress, IERC20_ABI, signer);
const amount = ethers.parseUnits("100", 12); // 12 decimals for AJUN

// 1. Approve wrapper to pull Foreign Assets
await foreignAsset.approve(wrapperAddress, amount);

// 2. Deposit (lock Foreign Assets, mint wAJUN)
await wrapper.deposit(amount);
```

### Unwrap ERC20 Tokens (Withdraw)

```javascript
const erc20 = await ethers.getContractAt("AjunaERC20", erc20Address);

// 1. Approve wrapper to burnFrom your wAJUN
await erc20.approve(wrapperAddress, amount);

// 2. Withdraw (burn wAJUN, release Foreign Assets)
await wrapper.withdraw(amount);
```

## Security Features

- **UUPS proxy upgradeability** — both contracts can be upgraded to fix bugs without migrating users or losing state
- **Role-based access control** (OpenZeppelin `AccessControl`) — only the Wrapper can mint/burn
- **UPGRADER_ROLE** on AjunaERC20 — only accounts with this role can authorize upgrades
- **Owner-only upgrade** on AjunaWrapper — only the owner can authorize upgrades
- **burnFrom pattern** — the Wrapper cannot burn user tokens without their explicit ERC20 approval
- **Reentrancy protection** (`ReentrancyGuard`) on all state-changing user functions
- **Pausable** circuit breaker — owner can freeze all operations in an emergency
- **Token rescue** — owner can recover accidentally sent tokens (but not the locked foreign asset)
- **Immutable foreign asset address** — set once at initialization; if the precompile address ever needs to change, deploy a new implementation via UUPS upgrade (prevents an owner key compromise from redirecting the wrapper to a malicious token)
- **Initializer validation** — rejects zero addresses, prevents re-initialization
- **Implementation sealed** — `_disableInitializers()` in constructor prevents initializing the implementation directly

### Post-Deployment Checklist

After deploying to a live network:
1. Send 1–2 DOT to the Wrapper **proxy** address as **Existential Deposit** to prevent account reaping
2. Transfer `DEFAULT_ADMIN_ROLE` and `UPGRADER_ROLE` on AjunaERC20 to a **multisig/governance** address
3. Transfer ownership of AjunaWrapper to a **multisig/governance** address
4. **Renounce** `DEFAULT_ADMIN_ROLE` and `UPGRADER_ROLE` from the deployer account
5. Renounce ownership of AjunaWrapper from the deployer
6. Verify a small wrap/unwrap cycle end-to-end
7. Record both proxy addresses and implementation addresses for future reference

## Compilation

```bash
npx hardhat compile
```

Uses `@parity/resolc` to compile Solidity → RISC-V bytecode for `pallet-revive`.

## Deployment

### Testnet (Polkadot Hub TestNet)

1. Get test tokens from the [Polkadot Faucet](https://faucet.polkadot.io/)
2. `npx hardhat vars set PRIVATE_KEY`
3. `./scripts/deploy_testnet.sh`

### Production (Polkadot AssetHub)

1. Look up the AJUN precompile address: `npx ts-node scripts/lookup_ajun_asset.ts`
2. `npx hardhat vars set PRIVATE_KEY`
3. `FOREIGN_ASSET=0x... ./scripts/deploy_production.sh`

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the complete production deployment guide.

### Manual

```bash
FOREIGN_ASSET=0x... npx hardhat run scripts/deploy_wrapper.ts --network polkadotTestnet
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Compilation errors | `npx hardhat clean && npm install --legacy-peer-deps && npx hardhat compile` |
| Local node not pre-funded | Use `npx hardhat test` (in-memory) or fund via `scripts/fund_account.ts` |
| Dependency conflicts | Use `npm install --legacy-peer-deps` |

## Resources

- [Polkadot Revive Documentation](https://github.com/paritytech/polkadot-sdk/tree/master/substrate/frame/revive)
- [Hardhat Polkadot Plugin](https://github.com/paritytech/hardhat-polkadot)
- [ERC20 Precompile Docs](https://docs.polkadot.com/smart-contracts/precompiles/erc20/)
- [OpenZeppelin Contracts](https://docs.openzeppelin.com/contracts)

## License

ISC
