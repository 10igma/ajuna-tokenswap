# Security Model

This document describes the security features, access control model, threat mitigations, and audit considerations for the Ajuna Token Swap system.

---

## Table of Contents

- [Security Architecture Overview](#security-architecture-overview)
- [UUPS Proxy Upgradeability](#uups-proxy-upgradeability)
- [Access Control: AjunaERC20](#access-control-ajunaerc20)
- [Access Control: AjunaWrapper](#access-control-ajunawrapper)
- [Reentrancy Protection](#reentrancy-protection)
- [Pausable Circuit Breaker](#pausable-circuit-breaker)
- [Token Rescue](#token-rescue)
- [The Mint-and-Lock Invariant](#the-mint-and-lock-invariant)
- [BurnFrom Approval Pattern](#burnfrom-approval-pattern)
- [Storage Gaps](#storage-gaps)
- [Implementation Sealing](#implementation-sealing)
- [Initializer Validation](#initializer-validation)
- [Immutable Foreign Asset Address](#immutable-foreign-asset-address)
- [Known Risks & Mitigations](#known-risks--mitigations)
- [Production Hardening Checklist](#production-hardening-checklist)
- [Audit Scope](#audit-scope)

---

## Security Architecture Overview

```
┌────────────────────────────────────────────────────────────────────┐
│                        Security Layers                             │
├────────────────────────────────────────────────────────────────────┤
│  Layer 1: UUPS Proxy          — Upgradeable with authorization    │
│  Layer 2: Access Control      — Role-gated mint/burn/upgrade      │
│  Layer 3: Reentrancy Guard    — Prevents re-entrant calls         │
│  Layer 4: Pausable            — Emergency circuit breaker         │
│  Layer 5: Input Validation    — Zero-address and zero-amount      │
│  Layer 6: Invariant Checks    — totalSupply == locked balance     │
│  Layer 7: Approval Pattern    — burnFrom requires allowance       │
└────────────────────────────────────────────────────────────────────┘
```

---

## UUPS Proxy Upgradeability

Both contracts use the **UUPS (Universal Upgradeable Proxy Standard)** pattern from OpenZeppelin v5.

### How It Works

- The **proxy** (ERC1967Proxy) stores all state and delegates calls to the **implementation**
- The `upgradeTo()` / `upgradeToAndCall()` function is on the **implementation**, not the proxy
- This means the implementation itself controls who can authorize an upgrade
- If the implementation does not include UUPS logic, it becomes **permanently non-upgradeable**

### Authorization

| Contract | Who Can Upgrade | Enforcement |
|----------|----------------|-------------|
| **AjunaERC20** | `UPGRADER_ROLE` holders | `_authorizeUpgrade()` uses `onlyRole(UPGRADER_ROLE)` |
| **AjunaWrapper** | Contract owner | `_authorizeUpgrade()` uses `onlyOwner` |

### Why UUPS Over Transparent Proxy

- **Gas efficiency**: No admin-slot check on every call (unlike TransparentUpgradeableProxy)
- **Smaller proxy**: ERC1967Proxy is minimal — just stores implementation address + delegates
- **Explicit opt-in**: Each upgrade requires authorization in the implementation itself
- **Fail-safe**: If a new implementation omits `_authorizeUpgrade`, the contract becomes immutable

For detailed upgrade procedures, see [UPGRADE.md](UPGRADE.md).

---

## Access Control: AjunaERC20

AjunaERC20 uses OpenZeppelin's `AccessControlUpgradeable` with three roles:

### Roles

| Role | Hash | Granted To | Permissions |
|------|------|-----------|-------------|
| `DEFAULT_ADMIN_ROLE` | `0x00` | Deployer (initially) | Grant/revoke any role |
| `MINTER_ROLE` | `keccak256("MINTER_ROLE")` | AjunaWrapper proxy | `mint()`, `burnFrom()` |
| `UPGRADER_ROLE` | `keccak256("UPGRADER_ROLE")` | Deployer (initially) | `upgradeTo()`, `upgradeToAndCall()` |

### Key Design Decisions

- **The deployer does NOT receive `MINTER_ROLE`** — only the Wrapper can mint and burn
- **`DEFAULT_ADMIN_ROLE`** is the admin for all roles — it can grant/revoke `MINTER_ROLE` and `UPGRADER_ROLE`
- **Role hierarchy**: `DEFAULT_ADMIN_ROLE` → manages → `MINTER_ROLE`, `UPGRADER_ROLE`

### Post-Deployment Role Transfer

For production, the deployer should:
1. Grant `DEFAULT_ADMIN_ROLE` to a multisig
2. Grant `UPGRADER_ROLE` to a multisig
3. Renounce `DEFAULT_ADMIN_ROLE` from deployer
4. Renounce `UPGRADER_ROLE` from deployer

```solidity
// Transfer admin to multisig
token.grantRole(DEFAULT_ADMIN_ROLE, multisigAddress);
token.grantRole(UPGRADER_ROLE, multisigAddress);

// Renounce from deployer
token.renounceRole(DEFAULT_ADMIN_ROLE, deployerAddress);
token.renounceRole(UPGRADER_ROLE, deployerAddress);
```

---

## Access Control: AjunaWrapper

AjunaWrapper uses OpenZeppelin's `OwnableUpgradeable` with a single `owner`.

### Owner Permissions

| Action | Access |
|--------|--------|
| `pause()` / `unpause()` | `onlyOwner` |
| `rescueToken()` | `onlyOwner` |
| `upgradeTo()` / `upgradeToAndCall()` | `onlyOwner` |
| `transferOwnership()` | `onlyOwner` |

### Ownership Transfer

`AjunaWrapper` inherits `Ownable2StepUpgradeable`, which uses the standard
**two-step** ownership transfer flow:

```solidity
// Step 1: current owner proposes
wrapper.transferOwnership(newOwner);
// → emits OwnershipTransferStarted(currentOwner, newOwner)
// → owner() unchanged; pendingOwner() == newOwner

// Step 2: proposed owner accepts (must be msg.sender)
wrapper.acceptOwnership();
// → emits OwnershipTransferred(currentOwner, newOwner)
// → owner() == newOwner; pendingOwner() cleared
```

The current owner retains full control until `acceptOwnership()` is called by
the proposed owner. This prevents transfers to wrong, uncontrolled, or
unaware addresses — a single typo no longer hands the wrapper to the wrong
party irrecoverably.

Cancelling a pending transfer is done by re-calling `transferOwnership` with
a different address (or `address(0)` to clear the pending owner without
re-proposing).

### Renouncing Ownership Is Disabled

`renounceOwnership()` is overridden to always revert. The wrapper relies on a
live owner for `pause` / `unpause`, `rescueToken`, and UUPS upgrade
authorization. Renouncing ownership would permanently brick all of these
levers on a treasury that holds user funds — an unrecoverable state.

If a contract needs to be made permanently non-upgradeable in the future,
the correct path is a deliberate UUPS upgrade to an implementation whose
`_authorizeUpgrade` always reverts (see [UPGRADE.md](UPGRADE.md) →
"Making a Contract Non-Upgradeable"). Pause and rescue capabilities are
preserved by such an upgrade; renouncing ownership would discard them.

---

## Reentrancy Protection

Both `deposit()` and `withdraw()` on AjunaWrapper are protected by `ReentrancyGuardUpgradeable`:

```solidity
function deposit(uint256 amount) external nonReentrant whenNotPaused { ... }
function withdraw(uint256 amount) external nonReentrant whenNotPaused { ... }
```

### Why It Matters

The `deposit()` function calls `foreignAsset.transferFrom()` which is an **external call** to an untrusted contract. Without reentrancy protection, a malicious foreign asset contract could re-enter `deposit()` or `withdraw()` during the transfer.

The `nonReentrant` modifier uses a **mutex lock** — if the function is called while already executing, it reverts with `ReentrancyGuardReentrantCall()`.

---

## Pausable Circuit Breaker

The owner can pause all user-facing operations in an emergency:

```solidity
// Pause — blocks deposit() and withdraw()
wrapper.pause();

// Resume
wrapper.unpause();
```

### What Gets Paused

| Function | Paused? |
|----------|---------|
| `deposit()` | Yes — `whenNotPaused` |
| `withdraw()` | Yes — `whenNotPaused` |
| `pause()` / `unpause()` | No — always callable by owner |
| `rescueToken()` | No — always callable by owner |
| `upgradeTo()` | No — always callable by owner |
| ERC20 `transfer()`, `approve()` | No — wAJUN transfers remain active |

### When to Use

- Critical vulnerability discovered in the contract
- Suspicious activity detected (e.g., unusual large wraps/unwraps)
- Foreign asset precompile change pending — pause, update address, unpause
- During a planned contract upgrade

---

## Token Rescue

If someone accidentally sends ERC20 tokens to the Wrapper contract, the owner can rescue them:

```solidity
wrapper.rescueToken(tokenAddress, recipientAddress, amount);
```

### Safety Guard

The rescue function **cannot** be used to withdraw the locked Foreign Asset:

```solidity
require(tokenAddress != address(foreignAsset), "Cannot rescue locked foreign asset");
```

This prevents the owner from breaking the 1:1 backing invariant by draining the treasury.

---

## The Mint-and-Lock Invariant

The core security property of the system:

$$\text{wAJUN.totalSupply()} = \text{foreignAsset.balanceOf(wrapper)}$$

This invariant holds because:
- `deposit()`: transfers N foreign tokens **into** the wrapper, then mints N wAJUN
- `withdraw()`: burns N wAJUN, then transfers N foreign tokens **out of** the wrapper
- No other function can mint, burn, or move the locked foreign asset

### Invariant Verification

The test suite verifies this invariant after every operation:

```typescript
const totalSupply = await erc20.totalSupply();
const treasuryBalance = await foreignAsset.balanceOf(wrapperAddress);
expect(totalSupply).to.equal(treasuryBalance);
```

### What Could Break It

| Threat | Mitigation |
|--------|-----------|
| Owner drains locked tokens via `rescueToken` | `rescueToken` blocks `foreignAsset` address |
| Direct transfer to wrapper (no mint) | Invariant becomes `totalSupply < locked` — safely over-collateralized |
| Re-entrancy double-mint | `nonReentrant` modifier on both functions |
| Foreign asset rebasing | Not applicable — AJUN is a fixed-supply asset |

---

## BurnFrom Approval Pattern

The Wrapper **cannot** burn user tokens without explicit permission:

```
User → approve(wrapper, amount) → Wrapper → burnFrom(user, amount)
```

This uses the standard ERC20 `_spendAllowance` pattern:

```solidity
function burnFrom(address from, uint256 amount) public onlyRole(MINTER_ROLE) {
    _spendAllowance(from, _msgSender(), amount);
    _burn(from, amount);
}
```

### Why This Matters

- Users must **opt-in** to each withdrawal by approving the Wrapper
- The Wrapper cannot unilaterally drain user balances
- Each `burnFrom` deducts from the caller's allowance, so users control exactly how much can be burned

---

## Storage Gaps

Both contracts include reserved storage gaps for safe future upgrades:

```solidity
// AjunaERC20 — 49 reserved slots
uint256[49] private __gap;

// AjunaWrapper — 48 reserved slots
uint256[48] private __gap;
```

### Purpose

When adding new state variables to an upgraded implementation, the new variables occupy slots from the gap. This prevents **storage collision** with inherited contracts.

### Rule

When adding N new state variables to an upgrade:
1. Add the variables **before** `__gap`
2. Reduce `__gap` size by N

Example: Adding one new `mapping` to AjunaWrapper:
```solidity
mapping(address => uint256) public newMapping;  // Uses 1 slot
uint256[47] private __gap;                       // Was 48, now 47
```

For more details, see [UPGRADE.md](UPGRADE.md).

---

## Implementation Sealing

Both implementations have their initializers disabled in the constructor:

```solidity
/// @custom:oz-upgrades-unsafe-allow constructor
constructor() {
    _disableInitializers();
}
```

### Why

Without this, someone could call `initialize()` directly on the implementation contract (not the proxy), setting themselves as admin/owner of the implementation. While this doesn't affect the proxy's state, it's a defense-in-depth measure that prevents confusion and potential exploits in edge cases.

### Test Coverage

```typescript
it("should prevent calling initialize on implementation directly", async () => {
    const impl = await ethers.deployContract("AjunaERC20");
    await expect(
        impl.initialize("X", "X", owner.address, 12)
    ).to.be.revertedWithCustomError(impl, "InvalidInitialization");
});
```

---

## Initializer Validation

Both `initialize()` functions validate their inputs:

```solidity
// AjunaERC20
require(admin != address(0), "AjunaERC20: admin is zero address");

// AjunaWrapper
require(_token != address(0), "AjunaWrapper: token is zero address");
require(_foreignAssetPrecompile != address(0), "AjunaWrapper: precompile is zero address");
```

Re-initialization is blocked by OpenZeppelin's `initializer` modifier, which prevents calling `initialize()` more than once.

---

## Immutable Foreign Asset Address

The foreign asset precompile address is set once during `initialize()` and **cannot be changed**. This is a deliberate security decision — it prevents an owner key compromise from redirecting the wrapper to a malicious token contract.

If the precompile address ever needs to change (e.g., asset ID reassignment), the recommended procedure is:

1. **Pause** the old wrapper: `wrapper.pause()`
2. **Deploy a new implementation** with the updated address via UUPS upgrade
3. **Verify** the new precompile responds correctly
4. **Unpause**: `wrapper.unpause()`

---

## Known Risks & Mitigations

| Risk | Severity | Mitigation |
|------|----------|-----------|
| **Owner key compromise** | Critical | Transfer to multisig post-deployment; use hardware wallets |
| **Upgrader key compromise** | Critical | Transfer `UPGRADER_ROLE` to multisig; renounce from deployer |
| **Malicious upgrade** | Critical | Multisig governance; timelock on upgrades (recommended) |
| **Foreign asset precompile removed** | High | Deploy new implementation via UUPS upgrade; pause first |
| **Existential deposit reaping** | Medium | Fund Wrapper with 1–2 DOT after deployment |
| **Storage collision on upgrade** | Medium | Use `__gap` correctly; test upgrade with OpenZeppelin plugin |
| **Front-running approval** | Low | Standard ERC20 issue; use `increaseAllowance` pattern |
| **Wrapper receives tokens directly** | Low | Over-collateralizes invariant; no negative impact |

---

## Production Hardening Checklist

Before going live, ensure:

- [ ] All roles transferred to a **multisig** (3-of-5 or 4-of-7 recommended)
- [ ] Deployer has **renounced** all privileged roles
- [ ] **Existential deposit** sent to Wrapper proxy (1–2 DOT)
- [ ] **Timelock contract** deployed in front of multisig (recommended: 24–48h delay)
- [ ] **Monitoring** set up for:
  - `Deposited` / `Withdrawn` events (unusual volumes)
  - `Paused` / `Unpaused` events
  - `Upgraded` events (proxy implementation change)
  - Invariant drift: `totalSupply != foreignAsset.balanceOf(wrapper)`
- [ ] **Audit completed** and findings addressed
- [ ] **Bug bounty program** established
- [ ] **Emergency response plan** documented (who can pause, when to pause, communication channels)

---

## Audit Scope

An audit of this system should cover:

### Smart Contracts
- `contracts/AjunaERC20.sol` — UUPS upgradeable ERC20 with AccessControl
- `contracts/AjunaWrapper.sol` — UUPS upgradeable treasury with Pausable, Reentrancy, Ownable
- `contracts/Proxy.sol` — ERC1967Proxy import (standard OpenZeppelin)
- `contracts/interfaces/IERC20Precompile.sol` — Interface definition

### Critical Paths
1. **Deposit flow**: `approve` → `transferFrom` → `mint` — correct ordering, reentrancy safety
2. **Withdraw flow**: `burnFrom` (with allowance) → `transfer` — correct ordering, reentrancy safety
3. **Upgrade flow**: `upgradeTo` → storage preserved, authorization enforced
4. **Pause flow**: `pause` → blocks deposits/withdrawals → `unpause` → resumes
5. **Role management**: Grant, revoke, renounce — proper access control hierarchy
6. **Invariant maintenance**: `totalSupply == locked balance` across all code paths

### Out of Scope
- OpenZeppelin library contracts (separately audited)
- Hardhat configuration and deployment scripts
- Frontend (frontend/app.html, frontend/test-ui.html)
- `polkadot-sdk` subtree
