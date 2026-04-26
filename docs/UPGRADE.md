# Upgrade Guide

This document explains how to upgrade the Ajuna Token Swap contracts using the UUPS proxy pattern.

---

## Table of Contents

- [Overview](#overview)
- [Who Can Upgrade](#who-can-upgrade)
- [Upgrade Process: Step by Step](#upgrade-process-step-by-step)
- [Writing a New Implementation](#writing-a-new-implementation)
- [Storage Layout Rules](#storage-layout-rules)
- [Testing Upgrades](#testing-upgrades)
- [Upgrade Examples](#upgrade-examples)
- [Rollback Considerations](#rollback-considerations)
- [Emergency Upgrade Procedure](#emergency-upgrade-procedure)
- [Making a Contract Non-Upgradeable](#making-a-contract-non-upgradeable)

---

## Overview

Both AjunaERC20 and AjunaWrapper are deployed behind **ERC1967 proxies** using the **UUPS pattern**. This means:

- The **proxy** holds all state (balances, roles, ownership, locked tokens)
- The **implementation** holds only logic (function code)
- Upgrading replaces the implementation **without** changing the proxy address or losing any state
- Users continue interacting with the **same proxy address** after an upgrade

```
Before Upgrade:
  Proxy (0xABC...) → Implementation V1 (0x111...)

After Upgrade:
  Proxy (0xABC...) → Implementation V2 (0x222...)
                     [V1 still exists on-chain but is unused]
```

---

## Who Can Upgrade

| Contract | Authorization | Mechanism |
|----------|--------------|-----------|
| **AjunaERC20** | Accounts with `UPGRADER_ROLE` | `onlyRole(UPGRADER_ROLE)` in `_authorizeUpgrade()` |
| **AjunaWrapper** | Contract owner | `onlyOwner` in `_authorizeUpgrade()` |

Initially, the deployer holds both `UPGRADER_ROLE` and ownership. After production deployment, these should be transferred to a multisig (see [SECURITY.md](SECURITY.md)).

---

## Upgrade Process: Step by Step

### 1. Write the New Implementation

Create a V2 contract that inherits the same base contracts and follows the [storage layout rules](#storage-layout-rules).

### 2. Compile

```bash
npx hardhat compile
```

### 3. Pause the Contract (Recommended)

```bash
# If upgrading AjunaWrapper, pause it first
npx hardhat run --network <network> -e \
  "const w = await ethers.getContractAt('AjunaWrapper', '<PROXY_ADDRESS>'); \
   await w.pause(); \
   console.log('Paused:', await w.paused());"
```

### 4. Deploy the New Implementation

```typescript
const NewImpl = await ethers.getContractFactory("AjunaERC20V2");
const newImpl = await NewImpl.deploy();
await newImpl.waitForDeployment();
console.log("New implementation:", await newImpl.getAddress());
```

### 5. Upgrade the Proxy

```typescript
// For AjunaERC20 (requires UPGRADER_ROLE)
const proxy = await ethers.getContractAt("AjunaERC20", PROXY_ADDRESS);
await proxy.upgradeToAndCall(await newImpl.getAddress(), "0x");

// For AjunaWrapper (requires owner)
const proxy = await ethers.getContractAt("AjunaWrapper", PROXY_ADDRESS);
await proxy.upgradeToAndCall(await newImpl.getAddress(), "0x");
```

If the new implementation needs a migration function, pass its calldata:

```typescript
const migrationData = NewImpl.interface.encodeFunctionData("migrateV2", [param1, param2]);
await proxy.upgradeToAndCall(await newImpl.getAddress(), migrationData);
```

### 6. Verify

```typescript
// Check the implementation address changed
const implSlot = await ethers.provider.getStorage(
  PROXY_ADDRESS,
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
);
console.log("Implementation:", ethers.getAddress("0x" + implSlot.slice(26)));

// Check state is preserved
const totalSupply = await proxy.totalSupply();
console.log("Total supply preserved:", totalSupply);
```

### 7. Unpause

```typescript
const wrapper = await ethers.getContractAt("AjunaWrapper", PROXY_ADDRESS);
await wrapper.unpause();
```

---

## Writing a New Implementation

### Template: AjunaERC20V2

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./AjunaERC20.sol";  // Inherit from V1

contract AjunaERC20V2 is AjunaERC20 {
    // ── New state variables (use gap slots) ──────────────────
    uint256 public newVariable;
    // Reduce __gap by the number of new variables added
    // Original __gap was 49, we added 1 variable, so now it's 48
    // IMPORTANT: Override the gap in the child contract

    // ── New functions ────────────────────────────────────────
    function newFeature() external view returns (uint256) {
        return newVariable;
    }

    // ── Migration (optional, called once via upgradeToAndCall) ──
    function migrateV2(uint256 initialValue) external onlyRole(UPGRADER_ROLE) {
        newVariable = initialValue;
    }

    // ── Version identifier (helpful for verification) ────────
    function version() external pure returns (string memory) {
        return "2.0.0";
    }
}
```

### Template: AjunaWrapperV2

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./AjunaWrapper.sol";

contract AjunaWrapperV2 is AjunaWrapper {
    uint256 public feeRate;  // New: fee percentage (basis points)

    function migrateV2(uint256 _feeRate) external onlyOwner {
        feeRate = _feeRate;
    }

    // Override deposit to add fee logic
    function deposit(uint256 amount) external override nonReentrant whenNotPaused {
        require(amount > 0, "Amount must be > 0");
        uint256 fee = (amount * feeRate) / 10000;
        uint256 netAmount = amount - fee;

        foreignAsset.transferFrom(msg.sender, address(this), amount);
        token.mint(msg.sender, netAmount);
        // fee stays locked in treasury

        emit Deposited(msg.sender, netAmount);
    }

    function version() external pure returns (string memory) {
        return "2.0.0";
    }
}
```

### Rules for New Implementations

1. **Inherit** from the previous version (V2 extends V1)
2. **Never** add a constructor with initialization logic — use a migration function instead
3. **Keep** `_disableInitializers()` in the constructor
4. **Never** remove existing state variables
5. **Never** change the order of existing state variables
6. **Add** new state variables only at the end, before `__gap`
7. **Reduce** `__gap` by the number of new slots used
8. **Keep** `_authorizeUpgrade()` — removing it makes the contract permanently non-upgradeable

---

## Storage Layout Rules

UUPS proxies delegate all storage to the proxy. The implementation defines the **layout** — which slot maps to which variable. Breaking the layout corrupts state.

### DO NOT

| Action | Why |
|--------|-----|
| Remove state variables | Shifts all subsequent slots, corrupting data |
| Reorder state variables | Changes slot assignments |
| Change variable types | `uint128` → `uint256` changes slot packing |
| Insert variables before existing ones | Shifts subsequent slots |
| Change inheritance order | Changes storage layout from base contracts |
| Remove `__gap` | Breaks upgrade compatibility |

### SAFE TO DO

| Action | Notes |
|--------|-------|
| Add new variables **at the end** before `__gap` | Reduce `__gap` by the slots used |
| Add new functions | Functions don't affect storage |
| Modify existing function logic | Logic changes are the primary reason for upgrades |
| Add new events | Events don't affect storage |
| Add new error types | Errors don't affect storage |

### Storage Slot Reference

OpenZeppelin Contracts Upgradeable v5 uses **ERC-7201 namespaced storage**:
each inherited base contract keeps its state in a single struct at a
deterministic slot derived from a namespace string, computed as
`keccak256(abi.encode(uint256(keccak256(namespace)) - 1)) & ~bytes32(uint256(0xff))`.

That means inherited base contracts (`ERC20Upgradeable`, `AccessControlUpgradeable`,
`OwnableUpgradeable`, `PausableUpgradeable`, `ReentrancyGuardUpgradeable`,
`UUPSUpgradeable`, `Initializable`) do not occupy sequential slots in the
derived contract — they live at non-overlapping hashed slots. The derived
contract has full use of slots starting at `0` for its own state.

```
AjunaERC20 (derived state, slots 0..):
  Slot 0:        _tokenDecimals (uint8)
  Slot 1..49:    __gap[49]      (reserved for future AjunaERC20 state)

  Inherited (namespaced, do not collide with derived slots):
  - Initializable           (openzeppelin.storage.Initializable)
  - ERC20Upgradeable        (openzeppelin.storage.ERC20)
  - AccessControlUpgradeable (openzeppelin.storage.AccessControl)
  - UUPSUpgradeable         (openzeppelin.storage.UUPSUpgradeable)

AjunaWrapper (derived state, slots 0..):
  Slot 0:        token         (AjunaERC20)
  Slot 1:        foreignAsset  (IERC20Precompile)
  Slot 2..49:    __gap[48]     (reserved for future AjunaWrapper state)

  Inherited (namespaced, do not collide with derived slots):
  - Initializable                (openzeppelin.storage.Initializable)
  - OwnableUpgradeable           (openzeppelin.storage.Ownable)
  - ReentrancyGuardUpgradeable   (openzeppelin.storage.ReentrancyGuard)
  - PausableUpgradeable          (openzeppelin.storage.Pausable)
  - UUPSUpgradeable              (openzeppelin.storage.UUPSUpgradeable)
```

**Practical rule for upgrades**: when adding new state to a derived contract,
add the new variable(s) immediately before `__gap` and shrink `__gap` by the
number of slots used. The `__gap` exists purely to reserve room for future
**derived-contract** state — it does not pad inherited base contracts (those
are already isolated by their namespaces).

---

## Testing Upgrades

### Unit Test Pattern

The test suite includes 8 UUPS-specific tests. Here's the pattern used:

```typescript
it("should allow owner to upgrade AjunaERC20", async () => {
    // Deploy a new (different) implementation
    const NewImpl = await ethers.getContractFactory("AjunaERC20");
    const newImpl = await NewImpl.deploy();

    // Upgrade the proxy to the new implementation
    await erc20.upgradeToAndCall(await newImpl.getAddress(), "0x");

    // Verify state is preserved
    const decimals = await erc20.decimals();
    expect(decimals).to.equal(12);
});

it("should preserve balances after AjunaWrapper upgrade", async () => {
    // Setup: deposit some tokens
    await foreignAsset.approve(wrapperAddress, amount);
    await wrapper.deposit(amount);

    // Record pre-upgrade state
    const preBalance = await erc20.balanceOf(user.address);
    const preTreasury = await foreignAsset.balanceOf(wrapperAddress);

    // Upgrade
    const NewImpl = await ethers.getContractFactory("AjunaWrapper");
    const newImpl = await NewImpl.deploy();
    await wrapper.upgradeToAndCall(await newImpl.getAddress(), "0x");

    // Verify state preserved
    expect(await erc20.balanceOf(user.address)).to.equal(preBalance);
    expect(await foreignAsset.balanceOf(wrapperAddress)).to.equal(preTreasury);
});
```

### What the Tests Verify

| Test | Assertion |
|------|-----------|
| Re-initialization blocked (x2) | `initialize()` reverts with `InvalidInitialization` |
| Unauthorized upgrade blocked (x2) | Non-upgrader/non-owner cannot call `upgradeToAndCall` |
| Successful upgrade (x2) | Owner/upgrader can upgrade; old functions still work |
| Balance preservation | User balances and treasury balance survive upgrade |
| Implementation sealed | `initialize()` on raw implementation reverts |

---

## Upgrade Examples

### Example 1: Add a Version Function

Minimal upgrade — just adds a `version()` view function:

```solidity
contract AjunaWrapperV2 is AjunaWrapper {
    function version() external pure returns (string memory) {
        return "2.0.0";
    }
}
```

Deploy and upgrade:

```typescript
const V2 = await ethers.getContractFactory("AjunaWrapperV2");
const v2Impl = await V2.deploy();
await wrapper.upgradeToAndCall(await v2Impl.getAddress(), "0x");
// Now wrapper.version() returns "2.0.0"
```

### Example 2: Fix a Bug in Withdraw Logic

```solidity
contract AjunaWrapperV2 is AjunaWrapper {
    function withdraw(uint256 amount) external override nonReentrant whenNotPaused {
        require(amount > 0, "Amount must be > 0");
        require(token.balanceOf(msg.sender) >= amount, "Insufficient ERC20 balance");

        // Bug fix: additional validation
        require(
            foreignAsset.balanceOf(address(this)) >= amount,
            "Insufficient treasury balance"
        );

        token.burnFrom(msg.sender, amount);
        bool success = foreignAsset.transfer(msg.sender, amount);
        require(success, "Foreign Asset return transfer failed");

        emit Withdrawn(msg.sender, amount);
    }
}
```

### Example 3: Add a Fee Mechanism (with Migration)

```solidity
contract AjunaWrapperV2 is AjunaWrapper {
    uint256 public feeRate;         // basis points (100 = 1%)
    address public feeRecipient;
    uint256[46] private __gap_v2;   // Reduced from 48 → 46 (added 2 vars)

    function setFeeConfig(uint256 _rate, address _recipient) external onlyOwner {
        require(_rate <= 1000, "Fee too high");  // max 10%
        feeRate = _rate;
        feeRecipient = _recipient;
    }
}
```

Upgrade with migration:
```typescript
const migrationData = V2.interface.encodeFunctionData("setFeeConfig", [50, feeRecipient]);
await wrapper.upgradeToAndCall(await v2Impl.getAddress(), migrationData);
```

---

## Rollback Considerations

### Can You Roll Back to V1?

Technically **yes** — you can call `upgradeToAndCall(v1ImplAddress, "0x")` to point back to the original implementation. However:

- If V2 added new state variables, V1 won't know about them (they'll be ignored but preserved in storage)
- If V2 modified the semantics of existing variables, rolling back may cause inconsistencies
- The safest rollback is always **forward** — deploy a V3 that fixes V2's issues

### Best Practice

1. Always keep the old implementation deployed on-chain (don't self-destruct)
2. Record every implementation address in your deployment log
3. Test rollback scenarios in your upgrade test suite

---

## Emergency Upgrade Procedure

When a critical vulnerability is discovered:

1. **Pause immediately**: `wrapper.pause()` (or `token` if the vulnerability is in ERC20)
2. **Write and audit the fix** — even under pressure, review carefully
3. **Deploy the fix to testnet** and verify with E2E tests
4. **Deploy the new implementation** to production
5. **Upgrade**: `proxy.upgradeToAndCall(newImpl, "0x")`
6. **Verify**: Check state preservation, run a small wrap/unwrap
7. **Unpause**: `wrapper.unpause()`
8. **Post-mortem**: Document what happened and improve prevention

### Time-Critical Decisions

If the vulnerability allows funds to be drained:
- Pause is faster than upgrade — always pause first
- Consider whether the attacker can exploit during the upgrade transaction itself
- If the Wrapper is paused, `deposit()` and `withdraw()` are blocked, which limits the attack surface

---

## Making a Contract Non-Upgradeable

If you want to permanently lock the implementation (renounce upgradeability):

### For AjunaERC20

Renounce `UPGRADER_ROLE` from all holders:

```solidity
// After all upgrades are complete
token.renounceRole(UPGRADER_ROLE, multisigAddress);
// If DEFAULT_ADMIN_ROLE is also renounced, no one can ever grant UPGRADER_ROLE again
token.renounceRole(DEFAULT_ADMIN_ROLE, multisigAddress);
```

### For AjunaWrapper

Renounce ownership:

```solidity
wrapper.renounceOwnership();
```

> **WARNING**: This is irreversible. The contract becomes permanently non-upgradeable, non-pausable, and the foreign asset address becomes immutable. Only do this when you are fully confident the contract is bug-free and feature-complete.

### Alternative: Deploy a Non-UUPS Implementation

Deploy a new implementation that **does not** include `_authorizeUpgrade()`:

```solidity
contract AjunaWrapperFinal is AjunaWrapper {
    // Override _authorizeUpgrade to always revert
    function _authorizeUpgrade(address) internal pure override {
        revert("Upgrades permanently disabled");
    }
}
```

Upgrade to this implementation, and no further upgrades are possible.
