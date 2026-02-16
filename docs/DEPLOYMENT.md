# Deployment Guide

This guide covers deploying the Ajuna Token Swap system across all supported environments.

---

## Table of Contents

- [Deployment Overview](#deployment-overview)
- [Environment Configuration](#environment-configuration)
- [Level 1: Unit Tests (In-Memory)](#level-1-unit-tests-in-memory)
- [Level 2: Local PVM Integration](#level-2-local-pvm-integration)
- [Level 3: Chopsticks (Forked AssetHub)](#level-3-chopsticks-forked-assethub)
- [Level 4: Testnet](#level-4-testnet)
- [Level 5: Production (Mainnet)](#level-5-production-mainnet)
- [Proxy Deployment Internals](#proxy-deployment-internals)
- [Post-Deployment Checklist](#post-deployment-checklist)
- [Precompile Address Calculation](#precompile-address-calculation)

---

## Deployment Overview

Each contract is deployed as a **UUPS proxy** consisting of two on-chain contracts:

```
┌──────────────────────┐        ┌────────────────────────┐
│  ERC1967Proxy        │──────→ │  Implementation        │
│  (stores state)      │  delegatecall  (stores logic)   │
│  permanent address   │        │  replaceable            │
└──────────────────────┘        └────────────────────────┘
```

The deployment process for each contract is:
1. Deploy the **implementation** contract (logic only)
2. Deploy an **ERC1967Proxy** pointing to the implementation, with `initialize()` calldata
3. The proxy address becomes the permanent contract address

The full system deploys **three** proxy pairs:
- **AjunaERC20** (wAJUN token) — proxy + implementation
- **AjunaWrapper** (treasury) — proxy + implementation
- **Mock Foreign Asset** (local dev only) — proxy + implementation

Plus a **role grant**: `MINTER_ROLE` on AjunaERC20 is granted to the AjunaWrapper proxy address.

---

## Environment Configuration

All environment settings live in `deployments.config.ts`:

```typescript
import { getEnvConfig } from "./deployments.config";

const cfg = getEnvConfig("local");     // or "testnet", "chopsticks"
console.log(cfg.chainId);              // 420420420
console.log(cfg.rpcUrl);               // http://127.0.0.1:8545
console.log(cfg.decimals);             // 12
```

| Environment | Chain ID | RPC URL | Foreign Asset |
|-------------|----------|---------|---------------|
| `local` | 420420420 | `http://127.0.0.1:8545` | Mock ERC20 (deployed) |
| `testnet` | 420420417 | `https://services.polkadothub-rpc.com/testnet` | Real precompile |
| `chopsticks` | 420420420 | `http://127.0.0.1:8545` | Real precompile (forked) |

### Hardhat Networks

Configured in `hardhat.config.ts`:

```typescript
networks: {
  local: {
    url: "http://127.0.0.1:8545",
    chainId: 420420420,
    accounts: [vars.get("PRIVATE_KEY", "0x5fb92d6e98884f76de468fa3f6278f8807c48bebc13595d45af5bdc4da702133")]
  },
  polkadotTestnet: {
    url: "https://services.polkadothub-rpc.com/testnet",
    chainId: 420420417,
    accounts: [vars.get("PRIVATE_KEY", "...")]
  }
}
```

The default private key is **Alith's** well-known dev key. For testnet/production, set your own:

```bash
npx hardhat vars set PRIVATE_KEY
```

---

## Level 1: Unit Tests (In-Memory)

No deployment needed — Hardhat's in-memory EVM handles everything:

```bash
npx hardhat test
```

All 60 tests run against mock contracts, including UUPS proxy deployment patterns.

---

## Level 2: Local PVM Integration

### Prerequisites

- Local node running: `./scripts/run_local_node.sh`
- Contracts compiled: `npx hardhat compile`

### Option A: Automated Pipeline (Recommended)

```bash
./scripts/e2e_local.sh
```

This script:
1. Checks node connectivity at `http://127.0.0.1:8545`
2. Verifies Alith is funded (pre-funded in genesis)
3. Deploys mock Foreign Asset (AjunaERC20 behind proxy)
4. Deploys AjunaERC20 + AjunaWrapper (both behind proxies)
5. Grants `MINTER_ROLE` to Wrapper
6. Runs E2E wrap/unwrap test

### Option B: Step-by-Step

```bash
# 1. Deploy a mock Foreign Asset
npx hardhat run scripts/deploy_mock_foreign_asset.ts --network local
# Output: Mock Foreign Asset (proxy) deployed at: 0x...

# 2. Deploy the wrapper system (ERC20 + Wrapper + role grant)
FOREIGN_ASSET=0x<mock_fa_address> npx hardhat run scripts/deploy_wrapper.ts --network local
# Output:
#   ERC20_ADDRESS=0x...
#   WRAPPER_ADDRESS=0x...
#   FOREIGN_ASSET=0x...

# 3. Run E2E test
WRAPPER_ADDRESS=0x... ERC20_ADDRESS=0x... FOREIGN_ASSET=0x... \
  npx hardhat run scripts/e2e_test.ts --network local
```

### Option C: Ignition Module

```bash
npx hardhat ignition deploy ./ignition/modules/AjunaWrapper.ts --network local \
  --parameters '{"AjunaWrapperModule": {"foreignAssetAddress": "0x<mock_fa_address>"}}'
```

> **Note**: `@parity/hardhat-polkadot` overrides the Ignition deploy task. The plain script (`deploy_wrapper.ts`) is more reliable for automated pipelines.

---

## Level 3: Chopsticks (Forked AssetHub)

Chopsticks forks a live chain's state, giving you the **real runtime** including registered foreign assets and precompile addresses.

### Setup

```bash
# 1. Start Chopsticks fork of AssetHub
npx @acala-network/chopsticks --config=chopsticks.yml

# 2. Start the eth-rpc adapter (points to Chopsticks WS at port 8000)
./polkadot-sdk/target/release/eth-rpc --node-rpc-url ws://127.0.0.1:8000
```

### Fund Test Accounts

Chopsticks supports `dev_setStorage` to inject balances:

```javascript
// Fund a test address with DOT (for gas)
await api.rpc('dev_setStorage', {
  System: {
    Account: [
      [
        ['<your_h160_address>'],
        { data: { free: '100000000000000' } }  // 100 DOT (12 decimals)
      ]
    ]
  }
});

// Fund with AJUN foreign asset tokens
await api.rpc('dev_setStorage', {
  ForeignAssets: {
    Account: [
      [
        [{ parents: 1, interior: { X1: [{ Parachain: 2051 }] } }, '<your_h160_address>'],
        { balance: '10000000000000000' }  // 10,000 AJUN (12 decimals)
      ]
    ]
  }
});
```

### Deploy

```bash
# Use the REAL precompile address from the forked state
FOREIGN_ASSET=0x<real_precompile_address> \
  npx hardhat run scripts/deploy_wrapper.ts --network local
```

---

## Level 4: Testnet

### Prerequisites

1. **PAS test tokens** from the [Polkadot Faucet](https://faucet.polkadot.io/)
2. **AJUN registered** as a foreign asset on AssetHub testnet (via XCM from Ajuna testnet)
3. **Private key** set in Hardhat:
   ```bash
   npx hardhat vars set PRIVATE_KEY
   ```

### Look Up the AJUN Asset ID

```bash
npx ts-node scripts/lookup_ajun_asset.ts wss://westend-asset-hub-rpc.polkadot.io
```

This queries the chain for the AJUN foreign asset and returns its local asset ID.

### Compute the Precompile Address

```bash
npx ts-node -e \
  "import {computePrecompileAddress} from './deployments.config'; \
   console.log(computePrecompileAddress(<ASSET_ID>, 0x0220))"
```

### Deploy

```bash
# Automated
./scripts/deploy_testnet.sh

# Or manual
FOREIGN_ASSET=0x<precompile_address> \
  npx hardhat run scripts/deploy_wrapper.ts --network polkadotTestnet
```

### Verify

```bash
WRAPPER_ADDRESS=0x... ERC20_ADDRESS=0x... FOREIGN_ASSET=0x... \
  npx hardhat run scripts/e2e_test.ts --network polkadotTestnet
```

---

## Level 5: Production (Mainnet)

> **WARNING**: Production deployment is irreversible. Follow every step carefully.

### Pre-Deployment

1. All tests pass on Levels 1–4
2. Audit completed (see [SECURITY.md](SECURITY.md))
3. Multisig wallet created for admin operations
4. Precompile address confirmed against live runtime

### Deploy

```bash
FOREIGN_ASSET=0x<mainnet_precompile_address> \
  npx hardhat run scripts/deploy_wrapper.ts --network <mainnet_network>
```

### Post-Deployment (Critical)

Execute the [Post-Deployment Checklist](#post-deployment-checklist) immediately after deployment.

---

## Proxy Deployment Internals

The `deploy_wrapper.ts` script uses a `deployProxy()` helper:

```typescript
async function deployProxy(implFactory, initArgs, initFunction = "initialize") {
  // 1. Deploy implementation contract
  const impl = await implFactory.deploy();

  // 2. Encode initialize() calldata
  const initData = implFactory.interface.encodeFunctionData(initFunction, initArgs);

  // 3. Deploy ERC1967Proxy with implementation address + init calldata
  const ProxyFactory = await ethers.getContractFactory("ERC1967Proxy");
  const proxy = await ProxyFactory.deploy(await impl.getAddress(), initData);

  // 4. Return typed contract attached to proxy address
  return implFactory.attach(await proxy.getAddress());
}
```

### Deployment Sequence

```
1. Deploy AjunaERC20 implementation
2. Deploy ERC1967Proxy → AjunaERC20.initialize("Wrapped Ajuna", "WAJUN", deployer, 12)
3. Deploy AjunaWrapper implementation
4. Deploy ERC1967Proxy → AjunaWrapper.initialize(erc20Proxy, foreignAsset)
5. Grant MINTER_ROLE on AjunaERC20 proxy to AjunaWrapper proxy
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `FOREIGN_ASSET` | Yes | — | Foreign asset address (precompile or mock) |
| `DECIMALS` | No | `12` | Token decimals (must match native AJUN) |

---

## Post-Deployment Checklist

Execute these steps **in order** after deploying to any live network:

### Step 1: Fund the Wrapper (Existential Deposits)

The Wrapper contract must hold a minimum balance at the substrate level to avoid **account reaping** (where the runtime zeros the account if it falls below the Existential Deposit). Two separate balances matter:

#### 1a. Native Token ED (DOT / PAS)

Send native tokens to the Wrapper proxy address to keep its substrate account alive. This is a one-time transfer — the Wrapper never sends native tokens, so this balance only decreases if the runtime ED changes.

```bash
# Via polkadot.js CLI or Apps UI:
# balances.transferKeepAlive(dest: <wrapper_proxy_address>, value: 100_000_000)
# That's 0.01 DOT (10 decimals) — well above ED
```

| Network | ED | Recommended Seed |
|---------|-----|-----------------|
| Polkadot Asset Hub | ~0.01 DOT | 0.1 DOT |
| Paseo Asset Hub | ~0.01 PAS | 0.1 PAS |
| Local dev node | 0 (no ED) | Not needed |

> **Note**: This must be sent via a **substrate extrinsic** (`balances.transferKeepAlive`), not via `msg.value` in Solidity. The Wrapper has no `receive()` function and will reject native token Solidity transfers.

#### 1b. Foreign Asset ED (AJUN)

The `pallet-assets` / `pallet-foreign-assets` runtime also enforces a per-asset ED. If all users fully withdraw and the Wrapper's AJUN balance hits zero, the asset account is reaped — which means the next `deposit()` may fail or behave unexpectedly.

**Prevention**: Seed the Wrapper with a permanent dust deposit that is never withdrawn. The simplest way is to call `deposit()` with a small amount from an admin account:

```bash
# 1. Approve the Wrapper to spend 1 unit of AJUN foreign asset
# 2. Call wrapper.deposit(1)
# This locks 1 unit permanently, keeping the asset account alive
```

| Network | Typical Asset ED | Recommended Seed |
|---------|-----------------|-----------------|
| Polkadot Asset Hub | Varies per asset | 100 units (minimum) |
| Paseo Asset Hub | Varies per asset | 100 units |
| Local dev node | 0 (no ED) | Not needed |

> **Important**: This seed deposit mints 1 wAJUN to the admin account that is effectively locked — do not withdraw it. The cost is negligible (1 smallest unit = $10^{-12}$ AJUN).

### Step 2: Verify Wrap/Unwrap Round-Trip

- [ ] Execute a small `deposit()` + `withdraw()` to confirm end-to-end functionality
- [ ] Verify the invariant holds: `wAJUN.totalSupply() == AJUN.balanceOf(wrapper)`

### Step 3: Transfer Roles to Multisig

- [ ] **AjunaERC20 roles**:
  - `grantRole(DEFAULT_ADMIN_ROLE, multisig)`
  - `grantRole(UPGRADER_ROLE, multisig)`
  - `renounceRole(DEFAULT_ADMIN_ROLE, deployer)`
  - `renounceRole(UPGRADER_ROLE, deployer)`
- [ ] **AjunaWrapper ownership**:
  - `transferOwnership(multisig)` on the Wrapper proxy

### Step 4: Finalize

- [ ] **Record addresses**: Document both proxy and implementation addresses
- [ ] **Update frontend/app.html**: Set `CONFIG` with final proxy addresses, or use URL parameters
- [ ] **Test the dApp**: Verify MetaMask-connected wrap/unwrap in the browser

---

## Precompile Address Calculation

Each asset on AssetHub gets a deterministic ERC20 precompile address:

```
Address (20 bytes):
  Byte 0..3   = Asset ID (uint32, big-endian)
  Byte 4..15  = 0x000000000000000000000000
  Byte 16..17 = PREFIX (uint16, big-endian)
  Byte 18..19 = 0x0000
```

| Asset Type | Prefix |
|------------|--------|
| Native assets (`pallet-assets`) | `0x0120` |
| Foreign assets (`pallet-foreign-assets`) | `0x0220` |

**Example**: Asset ID 1984 (USDT) with native prefix:
```
0x 00000780 000000000000000000000000 0120 0000
→ 0x000007C000000000000000000000000001200000
```

**Compute via CLI**:
```bash
npx ts-node -e \
  "import {computePrecompileAddress} from './deployments.config'; \
   console.log(computePrecompileAddress(1984, 0x0120))"
```

**Compute via TypeScript**:
```typescript
import { computePrecompileAddress } from "./deployments.config";

const address = computePrecompileAddress(assetId, 0x0220); // foreign assets
```
