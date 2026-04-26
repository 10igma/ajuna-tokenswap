# Architecture

A deep dive into the contract architecture, proxy layout, storage model, and design decisions of the Ajuna Token Swap system.

---

## Table of Contents

- [System Overview](#system-overview)
- [The Mint-and-Lock Pattern](#the-mint-and-lock-pattern)
- [Contract Hierarchy](#contract-hierarchy)
- [Proxy Architecture](#proxy-architecture)
- [Storage Layout](#storage-layout)
- [Deployment Sequence](#deployment-sequence)
- [Data Flow: Deposit (Wrap)](#data-flow-deposit-wrap)
- [Data Flow: Withdraw (Unwrap)](#data-flow-withdraw-unwrap)
- [Foreign Asset Precompile](#foreign-asset-precompile)
- [Event System](#event-system)
- [Testing Architecture](#testing-architecture)
- [Environment Configuration](#environment-configuration)
- [File Structure](#file-structure)

---

## System Overview

```
                         Polkadot AssetHub (pallet-revive)
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  ┌─────────────────────────┐                                         │
│  │  Foreign Asset          │   Native AJUN ERC20 precompile          │
│  │  (IERC20Precompile)     │   Managed by pallet-foreign-assets      │
│  └──────────┬──────────────┘                                         │
│             │ transferFrom / transfer                                │
│             ▼                                                        │
│  ┌─────────────────────────┐      mint / burnFrom                    │
│  │  ERC1967Proxy           │──────────────────────┐                  │
│  │  ├── AjunaWrapper       │                      ▼                  │
│  │  │   (Treasury)         │        ┌─────────────────────────┐      │
│  │  │   • deposit()        │        │  ERC1967Proxy           │      │
│  │  │   • withdraw()       │        │  ├── AjunaERC20         │      │
│  │  │   • pause/unpause    │        │  │   (wAJUN Token)      │      │
│  │  │   • rescueToken      │        │  │   • ERC20 standard   │      │
│  │  └─────────────────────────┘     │  │   • mint (MINTER_ROLE)│      │
│  │                                  │  │   • burnFrom         │      │
│  │                                  │  └─────────────────────────┘   │
│  │                                                                   │
│  │   User holds: AJUN (foreign) + wAJUN (ERC20) + DOT (gas)         │
│  │                                                                   │
└──────────────────────────────────────────────────────────────────────┘
```

The system consists of **three** on-chain contracts, two of which are deployed behind UUPS proxies:

| Contract | Type | Upgradeable | Purpose |
|----------|------|-------------|---------|
| **AJUN Foreign Asset** | Precompile | No (runtime-managed) | Native AJUN token on AssetHub |
| **AjunaERC20** | UUPS Proxy | Yes (`UPGRADER_ROLE`) | Wrapped AJUN (wAJUN) ERC20 |
| **AjunaWrapper** | UUPS Proxy | Yes (`onlyOwner`) | Treasury — locks AJUN, mints wAJUN |

---

## The Mint-and-Lock Pattern

The core design pattern is **mint-and-lock** (also called "lock-and-mint"):

```
WRAP:   Lock AJUN in treasury → Mint wAJUN to user
UNWRAP: Burn wAJUN from user  → Release AJUN from treasury
```

### Invariant

At all times:

$$\text{wAJUN.totalSupply()} = \text{AJUN.balanceOf(wrapper)}$$

This guarantees that every wAJUN is backed 1:1 by a locked AJUN Foreign Asset. The invariant is maintained because:

1. **deposit()** atomically locks N AJUN and mints N wAJUN
2. **withdraw()** atomically burns N wAJUN and releases N AJUN
3. No other code path can mint, burn, or move locked AJUN

### Why Not a Simple Transfer?

Foreign Assets on AssetHub are managed by `pallet-foreign-assets` and exposed via ERC20 precompiles. These tokens are **not** standard ERC20s — they lack features like events, custom logic, or DeFi composability. By wrapping into a standard ERC20:

- wAJUN emits standard ERC20 `Transfer` events
- wAJUN is composable with any ERC20-compatible DeFi protocol
- wAJUN can have additional features (e.g., permit, snapshots) via upgrades

---

## Contract Hierarchy

### AjunaERC20

```
Initializable
├── ERC20Upgradeable            (name, symbol, decimals, balances, allowances, totalSupply)
├── AccessControlUpgradeable    (roles: DEFAULT_ADMIN, MINTER, UPGRADER)
└── UUPSUpgradeable             (_authorizeUpgrade with UPGRADER_ROLE)
```

**Custom state:**
- `_tokenDecimals` (uint8) — set during initialization to match AJUN (12)

**Key functions:**
- `initialize(name, symbol, admin, decimals)` — called once via proxy
- `mint(to, amount)` — MINTER_ROLE only
- `burnFrom(from, amount)` — MINTER_ROLE only, requires allowance
- `decimals()` — returns `_tokenDecimals` (not hardcoded 18)

### AjunaWrapper

```
Initializable
├── Ownable2StepUpgradeable   (two-step transfer; renounceOwnership disabled)
├── ReentrancyGuard           (stateless, OZ ≥5.6; ERC-7201 namespaced)
├── PausableUpgradeable       (circuit breaker)
└── UUPSUpgradeable           (stateless re-export, OZ ≥5.6; onlyOwner upgrade auth)
```

**Custom state:**
- `token` (AjunaERC20) — the wAJUN proxy address
- `foreignAsset` (IERC20Precompile) — the AJUN precompile address

**Key functions:**
- `initialize(token, foreignAssetPrecompile)` — called once via proxy
- `deposit(amount)` — wrap AJUN → wAJUN
- `withdraw(amount)` — unwrap wAJUN → AJUN
- `pause()` / `unpause()` — circuit breaker
- `rescueToken(token, to, amount)` — rescue stray tokens

---

## Proxy Architecture

### ERC1967 Proxy Standard

Both contracts use OpenZeppelin's `ERC1967Proxy`, which stores the implementation address at a well-known storage slot:

```
Implementation slot: 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc
                     (bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1))
```

### UUPS vs Transparent Proxy

| Feature | UUPS (used here) | Transparent Proxy |
|---------|------------------|-------------------|
| Upgrade logic location | Implementation contract | Proxy admin |
| Gas per call | Lower (no admin check) | Higher (checks msg.sender) |
| Proxy size | Smaller | Larger |
| Can become immutable | Yes (remove upgrade fn) | No (admin always exists) |
| Risk | Must include upgrade in every impl | None (admin handles upgrades) |

### On-Chain Layout (per contract)

```
┌──────────────────────────────┐
│      ERC1967Proxy            │
│  ┌────────────────────────┐  │
│  │  Standard Proxy Storage │  │
│  │  • impl slot (EIP-1967)│  │
│  │  • admin slot (unused) │  │
│  └────────────────────────┘  │
│  ┌────────────────────────┐  │
│  │  Contract Storage       │  │
│  │  • _initialized         │  │
│  │  • balances/roles/owner│  │
│  │  • token/foreignAsset  │  │
│  │  • __gap[48-49]        │  │
│  └────────────────────────┘  │
│                              │
│  fallback() → delegatecall  │
│       to implementation      │
└──────────────────────────────┘
         │
         ▼ delegatecall
┌──────────────────────────────┐
│     Implementation           │
│  (code only, no state)       │
│  • initialize()              │
│  • deposit() / withdraw()    │
│  • mint() / burnFrom()       │
│  • _authorizeUpgrade()       │
│  • constructor disables init │
└──────────────────────────────┘
```

---

## Storage Layout

Both contracts inherit from OpenZeppelin Contracts v5 (with the upgradeable
package on top), which uses **ERC-7201 namespaced storage** ("storage of
structs at named slots"). Each inherited base contract stores its state in a
single struct at a deterministic slot derived from a namespace string:

```
slot(namespace) = keccak256(abi.encode(uint256(keccak256(namespace)) - 1)) & ~bytes32(uint256(0xff))
```

Concrete consequences:
- Inherited base contracts (`ERC20Upgradeable`, `AccessControlUpgradeable`,
  `Ownable2StepUpgradeable`, `PausableUpgradeable`, `ReentrancyGuard`,
  `UUPSUpgradeable`, `Initializable`) do **not** occupy sequential slots in
  the derived contract. They live at hashed, non-overlapping namespaces.
- As of OZ 5.6, `ReentrancyGuard` and `UUPSUpgradeable` are **stateless**
  in the sense that they have no init function — both use namespaced
  storage at fixed slots, so no `__init` call is required (and none exists).
  They are imported from `@openzeppelin/contracts` rather than the
  upgradeable package.
- The derived contract (`AjunaERC20` / `AjunaWrapper`) has full use of slots
  starting at `0` for its own state.
- The `__gap` arrays therefore only need to cover **future state added to the
  derived contract**, not the inherited bases.

### AjunaERC20 (derived storage, slots starting at 0)

| Slot Range | Variable | Type | Source |
|------------|----------|------|--------|
| 0 | `_tokenDecimals` | `uint8` | `AjunaERC20` |
| 1 – 49 | `__gap[49]` | `uint256[49]` | `AjunaERC20` (forward-compat reserve) |

Inherited state lives at namespaced slots, e.g. (informational):

| Namespace | Holds |
|-----------|-------|
| `openzeppelin.storage.Initializable` | `_initialized`, `_initializing` |
| `openzeppelin.storage.ERC20` | balances, allowances, total supply, name, symbol |
| `openzeppelin.storage.AccessControl` | role mappings |

### AjunaWrapper (derived storage, slots starting at 0)

| Slot Range | Variable | Type | Source |
|------------|----------|------|--------|
| 0 | `token` | `AjunaERC20` (address) | `AjunaWrapper` |
| 1 | `foreignAsset` | `IERC20Precompile` (address) | `AjunaWrapper` |
| 2 – 49 | `__gap[48]` | `uint256[48]` | `AjunaWrapper` (forward-compat reserve) |

Inherited state lives at namespaced slots, e.g. (informational):

| Namespace | Holds |
|-----------|-------|
| `openzeppelin.storage.Initializable` | `_initialized`, `_initializing` |
| `openzeppelin.storage.Ownable` | `_owner` |
| `openzeppelin.storage.ReentrancyGuard` | `_status` |
| `openzeppelin.storage.Pausable` | `_paused` |

---

## Deployment Sequence

```
Step 1: Deploy AjunaERC20 Implementation
  → impl1 = AjunaERC20.deploy()        (constructor calls _disableInitializers)

Step 2: Deploy AjunaERC20 Proxy
  → initData = encode("initialize", ["Wrapped Ajuna", "WAJUN", deployer, 12])
  → proxy1 = ERC1967Proxy.deploy(impl1, initData)
  → erc20 = AjunaERC20.attach(proxy1)

Step 3: Deploy AjunaWrapper Implementation
  → impl2 = AjunaWrapper.deploy()      (constructor calls _disableInitializers)

Step 4: Deploy AjunaWrapper Proxy
  → initData = encode("initialize", [proxy1, foreignAssetAddress])
  → proxy2 = ERC1967Proxy.deploy(impl2, initData)
  → wrapper = AjunaWrapper.attach(proxy2)

Step 5: Grant MINTER_ROLE
  → erc20.grantRole(MINTER_ROLE, proxy2)

Result:
  • erc20 (proxy1)  → impl1 (AjunaERC20 logic)
  • wrapper (proxy2) → impl2 (AjunaWrapper logic)
  • wrapper has MINTER_ROLE on erc20
  • deployer has DEFAULT_ADMIN_ROLE + UPGRADER_ROLE on erc20
  • deployer is owner of wrapper
```

---

## Data Flow: Deposit (Wrap)

```
User                    AjunaWrapper (proxy)        AjunaERC20 (proxy)      Foreign Asset
 │                            │                           │                      │
 │  approve(wrapper, 100)     │                           │                      │
 │────────────────────────────│───────────────────────────│──────────────────────→│
 │                            │                           │     ✓ allowance set  │
 │                            │                           │                      │
 │  deposit(100)              │                           │                      │
 │───────────────────────────→│                           │                      │
 │                            │  transferFrom(user,       │                      │
 │                            │    wrapper, 100)          │                      │
 │                            │──────────────────────────│──────────────────────→│
 │                            │                           │     ✓ 100 AJUN locked│
 │                            │                           │                      │
 │                            │  mint(user, 100)          │                      │
 │                            │──────────────────────────→│                      │
 │                            │                           │  ✓ 100 wAJUN minted  │
 │                            │                           │                      │
 │  ✓ Deposited(user, 100)    │                           │                      │
 │←───────────────────────────│                           │                      │
```

---

## Data Flow: Withdraw (Unwrap)

```
User                    AjunaWrapper (proxy)        AjunaERC20 (proxy)      Foreign Asset
 │                            │                           │                      │
 │  approve(wrapper, 50)      │                           │                      │
 │───────────────────────────│───────────────────────────→│                      │
 │                            │                           │  ✓ allowance set     │
 │                            │                           │                      │
 │  withdraw(50)              │                           │                      │
 │───────────────────────────→│                           │                      │
 │                            │  burnFrom(user, 50)       │                      │
 │                            │──────────────────────────→│                      │
 │                            │                           │  ✓ 50 wAJUN burned   │
 │                            │                           │  (allowance deducted)│
 │                            │                           │                      │
 │                            │  transfer(user, 50)       │                      │
 │                            │──────────────────────────│──────────────────────→│
 │                            │                           │  ✓ 50 AJUN released  │
 │                            │                           │                      │
 │  ✓ Withdrawn(user, 50)     │                           │                      │
 │←───────────────────────────│                           │                      │
```

---

## Foreign Asset Precompile

### What Is It?

On Polkadot AssetHub, tokens managed by `pallet-assets` and `pallet-foreign-assets` are exposed as ERC20 precompiles via `pallet-revive`. Each asset gets a deterministic address.

### Address Formula

```
Address (20 bytes) = [assetId (4B BE)] [zeros (12B)] [prefix (2B BE)] [0x0000]
```

| Pallet | Prefix |
|--------|--------|
| `pallet-assets` (native) | `0x0120` |
| `pallet-foreign-assets` | `0x0220` |

### Interface

The precompile implements standard ERC20:

```solidity
interface IERC20Precompile {
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
    function totalSupply() external view returns (uint256);
    function balanceOf(address who) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
    function approve(address spender, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}
```

### Mock vs Real

| Environment | Foreign Asset | Notes |
|-------------|--------------|-------|
| Hardhat in-memory | Mock AjunaERC20 | Deployed by test setup |
| Local dev node | Mock AjunaERC20 | No pallet-assets in runtime |
| Chopsticks | Real precompile | Forked from live state |
| Testnet/Mainnet | Real precompile | Registered via XCM |

---

## Event System

### AjunaWrapper Events

| Event | Parameters | When |
|-------|-----------|------|
| `Deposited` | `user` (indexed), `amount` | After successful wrap |
| `Withdrawn` | `user` (indexed), `amount` | After successful unwrap |
| `TokenRescued` | `tokenAddress` (indexed), `to` (indexed), `amount` | Stray tokens rescued |
| `Paused` | `account` | Contract paused (from PausableUpgradeable) |
| `Unpaused` | `account` | Contract unpaused |
| `OwnershipTransferred` | `previousOwner` (indexed), `newOwner` (indexed) | Ownership changed |
| `Upgraded` | `implementation` (indexed) | Proxy upgraded (from UUPSUpgradeable) |

### AjunaERC20 Events

| Event | Parameters | When |
|-------|-----------|------|
| `Transfer` | `from` (indexed), `to` (indexed), `value` | Token transfer, mint, or burn |
| `Approval` | `owner` (indexed), `spender` (indexed), `value` | Allowance set |
| `RoleGranted` | `role` (indexed), `account` (indexed), `sender` (indexed) | Role assigned |
| `RoleRevoked` | `role` (indexed), `account` (indexed), `sender` (indexed) | Role removed |
| `Upgraded` | `implementation` (indexed) | Proxy upgraded |

---

## Testing Architecture

### Four Testing Levels

```
Level 1: Hardhat In-Memory EVM
  ├── 61 unit tests (test/wrapper.test.ts)
  ├── Mock Foreign Asset (deployed in test setup)
  ├── Proxy deployment helpers (deployERC20Proxy, deployWrapperProxy)
  └── Tests: deployment, deposit, withdraw, access, pause, rescue, UUPS

Level 2: Local PVM (revive-dev-node)
  ├── scripts/e2e_local.sh (automated pipeline)
  ├── scripts/deploy_mock_foreign_asset.ts
  ├── scripts/deploy_wrapper.ts
  ├── scripts/e2e_test.ts
  └── Tests: PVM bytecode compatibility, gas costs

Level 3: Chopsticks (forked AssetHub)
  ├── chopsticks.yml
  ├── Real pallet-assets precompile
  └── Tests: Production-like with real runtime state

Level 4: Testnet / Mainnet
  ├── scripts/deploy_testnet.sh
  ├── Real XCM-transferred AJUN
  └── Tests: Full production path
```

### Test Helpers

The test suite uses proxy deployment helpers:

```typescript
async function deployERC20Proxy(deployer, name, symbol, admin, decimals) {
  const Impl = await ethers.getContractFactory("AjunaERC20");
  const impl = await Impl.deploy();
  const initData = Impl.interface.encodeFunctionData("initialize", [name, symbol, admin, decimals]);
  const Proxy = await ethers.getContractFactory("ERC1967Proxy");
  const proxy = await Proxy.deploy(await impl.getAddress(), initData);
  return Impl.attach(await proxy.getAddress());
}
```

---

## Environment Configuration

`deployments.config.ts` defines three environments with a helper for precompile address computation:

```typescript
export interface EnvConfig {
  name: string;           // "Local Dev Node"
  chainId: number;        // 420420420
  rpcUrl: string;         // "http://127.0.0.1:8545"
  decimals: number;       // 12
  symbol: string;         // "wAJUN"
  foreignAssetAddress: string;
  wrapperAddress: string;
  erc20Address: string;
}
```

---

## File Structure

```
ajuna-tokenswap/
├── contracts/                          # Solidity source
│   ├── AjunaERC20.sol                  # UUPS upgradeable ERC20 (wAJUN)
│   ├── AjunaWrapper.sol                # UUPS upgradeable treasury
│   ├── Proxy.sol                       # ERC1967Proxy import for deployment
│   └── interfaces/
│       └── IERC20Precompile.sol        # Foreign Asset ERC20 interface
│
├── test/
│   └── wrapper.test.ts                 # 61 unit tests (Hardhat in-memory)
│
├── scripts/
│   ├── setup_node.sh                   # Build revive-dev-node from source
│   ├── run_local_node.sh               # Start local node + eth-rpc
│   ├── deploy_mock_foreign_asset.ts    # Deploy mock FA for local testing
│   ├── deploy_wrapper.ts               # Deploy ERC20 + Wrapper (UUPS proxies)
│   ├── deploy_testnet.sh               # Deploy to Polkadot Hub TestNet
│   ├── deploy_production.sh            # Deploy to Polkadot Asset Hub mainnet
│   ├── e2e_test.ts                     # E2E integration test script
│   ├── e2e_local.sh                    # Full automated E2E pipeline
│   ├── fund_account.ts                 # Fund a test account from Alith
│   ├── lookup_ajun_asset.ts            # Query AJUN asset on live chain
│   └── serve_ui.sh                     # Serve UIs on localhost:8000
│
├── docs/                              # Documentation
│   ├── README.md                      # Documentation index
│   ├── QUICKSTART.md                  # Getting started guide
│   ├── DEPLOYMENT.md                  # Deployment guide (all environments)
│   ├── ARCHITECTURE.md                # This file
│   ├── SECURITY.md                    # Security model
│   ├── UPGRADE.md                     # UUPS upgrade guide
│   └── USAGE.md                       # Usage and integration guide
│
├── deployments.config.ts              # Multi-environment configuration
├── hardhat.config.ts                  # Hardhat project configuration
├── chopsticks.yml                     # Chopsticks fork config (AssetHub)
├── frontend/
│   ├── app.html                       # User-facing swap dApp (MetaMask)
│   └── test-ui.html                   # Developer testing interface
├── package.json                       # NPM dependencies
├── tsconfig.json                      # TypeScript configuration
│
├── artifacts/                         # Compiled contract artifacts (generated)
├── cache/                             # Hardhat cache (generated)
├── typechain-types/                   # TypeScript bindings (generated)
├── chain-specs/                       # Substrate chain specs
└── polkadot-sdk/                      # Polkadot SDK subtree (node binaries)
```
