# Usage Guide

This document covers how to interact with the Ajuna Token Swap contracts — from JavaScript/TypeScript integration to using the browser-based dApps.

---

## Table of Contents

- [Overview](#overview)
- [Contract Addresses](#contract-addresses)
- [JavaScript / ethers.js Integration](#javascript--ethersjs-integration)
- [Wrap Flow (AJUN → wAJUN)](#wrap-flow-ajun--wajun)
- [Unwrap Flow (wAJUN → AJUN)](#unwrap-flow-wajun--ajun)
- [Reading Balances and State](#reading-balances-and-state)
- [Admin Operations](#admin-operations)
- [Browser dApp (app.html)](#browser-dapp-apphtml)
- [Developer Testing UI (test-ui.html)](#developer-testing-ui-test-uihtml)
- [E2E Testing Script](#e2e-testing-script)
- [ABI Reference](#abi-reference)

---

## Overview

The wrap/unwrap flow involves two separate ERC20 `approve` + contract call sequences:

```
                        WRAP (Deposit)
User AJUN Balance ──→ [approve] ──→ [deposit] ──→ User wAJUN Balance
                    Foreign Asset     Wrapper       AjunaERC20

                       UNWRAP (Withdraw)
User wAJUN Balance ──→ [approve] ──→ [withdraw] ──→ User AJUN Balance
                     AjunaERC20      Wrapper        Foreign Asset
```

**Key**: Every wrap/unwrap requires **two transactions** — one to approve, one to execute.

---

## Contract Addresses

After deployment, you need three addresses:

| Contract | Variable | Description |
|----------|----------|-------------|
| **AjunaERC20** (proxy) | `ERC20_ADDRESS` | The wAJUN token contract |
| **AjunaWrapper** (proxy) | `WRAPPER_ADDRESS` | The treasury contract |
| **Foreign Asset** | `FOREIGN_ASSET` | The AJUN precompile (or mock ERC20) |

These are printed by the deploy scripts and can be passed via environment variables or URL parameters.

---

## JavaScript / ethers.js Integration

### Setup (Node.js / Hardhat)

```typescript
import { ethers } from "hardhat";

// Connect to deployed proxies
const wrapper = await ethers.getContractAt("AjunaWrapper", WRAPPER_ADDRESS);
const erc20 = await ethers.getContractAt("AjunaERC20", ERC20_ADDRESS);

// Foreign asset uses the standard ERC20 interface
const foreignAsset = new ethers.Contract(FOREIGN_ASSET, [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function transfer(address, uint256) returns (bool)",
  "function decimals() view returns (uint8)",
], signer);
```

### Setup (Browser with ethers v5)

```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/ethers/5.7.2/ethers.umd.min.js"></script>
<script>
  const provider = new ethers.providers.Web3Provider(window.ethereum);
  const signer = provider.getSigner();

  const ERC20_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function approve(address, uint256) returns (bool)",
    "function allowance(address, address) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function totalSupply() view returns (uint256)",
  ];

  const WRAPPER_ABI = [
    "function deposit(uint256)",
    "function withdraw(uint256)",
    "function token() view returns (address)",
    "function foreignAsset() view returns (address)",
    "function paused() view returns (bool)",
  ];

  const foreignAsset = new ethers.Contract(FOREIGN_ASSET, ERC20_ABI, signer);
  const erc20 = new ethers.Contract(ERC20_ADDRESS, ERC20_ABI, signer);
  const wrapper = new ethers.Contract(WRAPPER_ADDRESS, WRAPPER_ABI, signer);
</script>
```

---

## Wrap Flow (AJUN → wAJUN)

### Step 1: Approve the Wrapper to Pull AJUN

The user must approve the Wrapper contract to transfer their Foreign Asset tokens:

```typescript
const TOKEN_DECIMALS = 12;
const amount = ethers.parseUnits("100", TOKEN_DECIMALS); // 100 AJUN

// Approve Wrapper to spend user's foreign assets
const approveTx = await foreignAsset.approve(WRAPPER_ADDRESS, amount);
await approveTx.wait();
console.log("Approved Wrapper to spend", ethers.formatUnits(amount, TOKEN_DECIMALS), "AJUN");
```

### Step 2: Deposit (Wrap)

```typescript
const depositTx = await wrapper.deposit(amount);
await depositTx.wait();
console.log("Wrapped", ethers.formatUnits(amount, TOKEN_DECIMALS), "AJUN → wAJUN");
```

### What Happens On-Chain

1. `foreignAsset.transferFrom(user, wrapper, amount)` — locks AJUN in treasury
2. `token.mint(user, amount)` — mints equivalent wAJUN to user

### Verify

```typescript
const wajunBalance = await erc20.balanceOf(userAddress);
console.log("wAJUN balance:", ethers.formatUnits(wajunBalance, TOKEN_DECIMALS));
```

---

## Unwrap Flow (wAJUN → AJUN)

### Step 1: Approve the Wrapper to Burn wAJUN

```typescript
const amount = ethers.parseUnits("50", TOKEN_DECIMALS); // 50 wAJUN

// Approve Wrapper to burn user's wAJUN (burnFrom requires allowance)
const approveTx = await erc20.approve(WRAPPER_ADDRESS, amount);
await approveTx.wait();
console.log("Approved Wrapper to burn", ethers.formatUnits(amount, TOKEN_DECIMALS), "wAJUN");
```

### Step 2: Withdraw (Unwrap)

```typescript
const withdrawTx = await wrapper.withdraw(amount);
await withdrawTx.wait();
console.log("Unwrapped", ethers.formatUnits(amount, TOKEN_DECIMALS), "wAJUN → AJUN");
```

### What Happens On-Chain

1. `token.burnFrom(user, amount)` — burns wAJUN from user (requires prior approval)
2. `foreignAsset.transfer(user, amount)` — releases AJUN from treasury to user

### Verify

```typescript
const ajunBalance = await foreignAsset.balanceOf(userAddress);
console.log("AJUN balance:", ethers.formatUnits(ajunBalance, TOKEN_DECIMALS));
```

---

## Reading Balances and State

### User Balances

```typescript
const userAddress = await signer.getAddress();

// Foreign Asset (AJUN) balance
const ajunBal = await foreignAsset.balanceOf(userAddress);
console.log("AJUN:", ethers.formatUnits(ajunBal, 12));

// Wrapped token (wAJUN) balance
const wajunBal = await erc20.balanceOf(userAddress);
console.log("wAJUN:", ethers.formatUnits(wajunBal, 12));

// Native balance (DOT/DEV for gas)
const nativeBal = await ethers.provider.getBalance(userAddress);
console.log("Native:", ethers.formatUnits(nativeBal, 12));
```

### Contract State

```typescript
// Wrapper paused?
const paused = await wrapper.paused();

// Treasury balance (locked AJUN)
const treasuryBal = await foreignAsset.balanceOf(WRAPPER_ADDRESS);

// Total wAJUN supply
const totalSupply = await erc20.totalSupply();

// Invariant check
console.log("Invariant holds:", totalSupply === treasuryBal);

// Token decimals
const decimals = await erc20.decimals();

// Linked addresses
const tokenAddr = await wrapper.token();
const foreignAddr = await wrapper.foreignAsset();
```

### Allowances

```typescript
// How much AJUN the user has approved the Wrapper to spend
const ajunAllowance = await foreignAsset.allowance(userAddress, WRAPPER_ADDRESS);

// How much wAJUN the user has approved the Wrapper to burn
const wajunAllowance = await erc20.allowance(userAddress, WRAPPER_ADDRESS);
```

---

## Admin Operations

### Pause / Unpause

```typescript
// Pause (blocks deposit and withdraw)
await wrapper.pause();

// Unpause
await wrapper.unpause();

// Check status
const isPaused = await wrapper.paused();
```

### Rescue Accidentally Sent Tokens

```typescript
// Recover tokens that were accidentally sent to the Wrapper
// CANNOT rescue the locked foreign asset
await wrapper.rescueToken(tokenAddress, recipientAddress, amount);
```

### Grant / Revoke Roles (AjunaERC20)

```typescript
const MINTER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("MINTER_ROLE"));
const UPGRADER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("UPGRADER_ROLE"));

// Grant a role
await erc20.grantRole(MINTER_ROLE, newMinterAddress);

// Revoke a role
await erc20.revokeRole(UPGRADER_ROLE, oldUpgraderAddress);

// Renounce your own role
await erc20.renounceRole(UPGRADER_ROLE, myAddress);

// Check role membership
const hasMinter = await erc20.hasRole(MINTER_ROLE, address);
```

### Transfer Ownership (AjunaWrapper)

```typescript
// Two-step transfer
await wrapper.transferOwnership(newOwnerAddress);
// New owner must accept:
// await wrapper.connect(newOwner).acceptOwnership();
```

---

## Browser dApp (app.html)

A wallet-connected swap interface for end users.

### Setup

1. **Start the UI server**:
   ```bash
   ./scripts/serve_ui.sh
   ```

2. **Open with contract addresses** as URL parameters:
   ```
   http://localhost:8000/app.html?wrapper=0x...&erc20=0x...&foreign=0x...
   ```

   Or edit the `CONFIG` object in the `<script>` section of `app.html`.

3. **Connect your wallet** — supports MetaMask, SubWallet, Talisman (EVM mode)

### MetaMask Network Configuration

| Field | Local Dev Node | Polkadot Hub TestNet |
|-------|---------------|---------------------|
| Network Name | AssetHub Local | AssetHub TestNet |
| RPC URL | `http://127.0.0.1:8545` | `https://services.polkadothub-rpc.com/testnet` |
| Chain ID | `420420420` | `420420417` |
| Currency Symbol | `DOT` | `DOT` |

### Wrap Workflow

1. Enter the amount of AJUN to wrap
2. Click **"Approve AJUN"** → confirm in wallet
3. Wait for approval transaction to be mined
4. Click **"Wrap → Receive wAJUN"** → confirm in wallet
5. wAJUN balance updates automatically

### Unwrap Workflow

1. Switch to the **Unwrap** tab
2. Enter the amount of wAJUN to unwrap
3. Click **"Approve wAJUN"** → confirm in wallet
4. Click **"Unwrap → Receive AJUN"** → confirm in wallet
5. AJUN balance updates automatically

---

## Developer Testing UI (test-ui.html)

A developer-oriented interface that uses hardcoded test accounts (no wallet needed).

### Setup

1. **Start the local node**: `./scripts/run_local_node.sh`
2. **Deploy contracts**: `./scripts/e2e_local.sh` (or manually)
3. **Start the UI server**: `./scripts/serve_ui.sh`
4. **Open**: http://localhost:8000/test-ui.html

### Usage

1. Paste the **Wrapper**, **ERC20**, and **Foreign Asset** addresses
2. Click **"Load Contracts"**
3. Click **"Fund Test Account"** — sends 100 DEV from Alith
4. Click **"Approve Foreign Asset"** → **"Deposit"** (wrap)
5. Click **"Approve ERC20 (wAJUN)"** → **"Withdraw"** (unwrap)
6. Observe balances and treasury invariant update in real-time

### Test Accounts

| Name | Address | Private Key |
|------|---------|-------------|
| **Alith** (funder) | `0xf24FF3a9CF04c71Dbc94D0b566f7A27B94566cac` | `0x5fb92d6e98884f76de468fa3f6278f8807c48bebc13595d45af5bdc4da702133` |
| **Baltathar** (test user) | `0x3Cd0A705a2DC65e5b1E1205896BaA2be8A07c6e0` | `0x8075991ce870b93a8870eca0c0f91913d12f47948ca0fd25b49c6fa7cdbeee8b` |

> **WARNING**: These are well-known dev keys — never use them on any real network.

---

## E2E Testing Script

The `scripts/e2e_test.ts` script runs a full wrap → unwrap cycle against a live network:

```bash
WRAPPER_ADDRESS=0x... ERC20_ADDRESS=0x... FOREIGN_ASSET=0x... \
  npx hardhat run scripts/e2e_test.ts --network local
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `WRAPPER_ADDRESS` | Yes | — | AjunaWrapper proxy address |
| `ERC20_ADDRESS` | Yes | — | AjunaERC20 proxy address |
| `FOREIGN_ASSET` | Yes | — | Foreign asset address |
| `AMOUNT` | No | `"100"` | Amount to wrap/unwrap (human-readable) |

### What It Tests

1. **Pre-conditions**: Verifies balances and contract state
2. **Approve + Deposit**: Wraps AJUN → wAJUN
3. **Verify**: Checks balances match expectations, invariant holds
4. **Approve + Withdraw**: Unwraps wAJUN → AJUN
5. **Final verification**: Checks all balances restored, invariant still holds

### Automated Pipeline

For a fully automated run on a local node:

```bash
# In terminal 1:
./scripts/run_local_node.sh

# In terminal 2:
./scripts/e2e_local.sh
```

The pipeline deploys everything and runs the E2E test automatically, printing a URL for browser testing at the end.

---

## ABI Reference

### AjunaERC20 (wAJUN)

```solidity
// ERC20 Standard
function name() view returns (string)
function symbol() view returns (string)
function decimals() view returns (uint8)
function totalSupply() view returns (uint256)
function balanceOf(address account) view returns (uint256)
function transfer(address to, uint256 amount) returns (bool)
function allowance(address owner, address spender) view returns (uint256)
function approve(address spender, uint256 amount) returns (bool)
function transferFrom(address from, address to, uint256 amount) returns (bool)

// Minting & Burning (MINTER_ROLE only)
function mint(address to, uint256 amount)
function burnFrom(address from, uint256 amount)

// Access Control
function hasRole(bytes32 role, address account) view returns (bool)
function grantRole(bytes32 role, address account)
function revokeRole(bytes32 role, address account)
function renounceRole(bytes32 role, address callerConfirmation)
function MINTER_ROLE() view returns (bytes32)
function UPGRADER_ROLE() view returns (bytes32)
function DEFAULT_ADMIN_ROLE() view returns (bytes32)

// UUPS
function upgradeToAndCall(address newImplementation, bytes data)
function proxiableUUID() view returns (bytes32)

// Initializer
function initialize(string name_, string symbol_, address admin, uint8 decimals_)
```

### AjunaWrapper (Treasury)

```solidity
// Core
function deposit(uint256 amount)
function withdraw(uint256 amount)
function token() view returns (address)
function foreignAsset() view returns (address)

// Admin
function pause()
function unpause()
function paused() view returns (bool)
function rescueToken(address tokenAddress, address to, uint256 amount)

// Ownership
function owner() view returns (address)
function transferOwnership(address newOwner)
function renounceOwnership()

// UUPS
function upgradeToAndCall(address newImplementation, bytes data)
function proxiableUUID() view returns (bytes32)

// Initializer
function initialize(address _token, address _foreignAssetPrecompile)

// Events
event Deposited(address indexed user, uint256 amount)
event Withdrawn(address indexed user, uint256 amount)
event TokenRescued(address indexed tokenAddress, address indexed to, uint256 amount)
event Paused(address account)
event Unpaused(address account)
event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)
event Upgraded(address indexed implementation)
```
