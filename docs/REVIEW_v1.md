# Ajuna Token Swap — Security Review

**Date**: 2026-04-26
**Scope**: All Solidity contracts in `contracts/`, deployment scripts, test suite, and operational configuration.
**Status**: Supersedes the 2026-02-15 review. All prior findings re-verified against current code.

> **Update (post-review same-day)**: MEDIUM-A and LOW-B identified in §2 of this
> review have been fixed in code on the same day this review was written:
> `AjunaWrapper` now inherits `Ownable2StepUpgradeable` and `renounceOwnership`
> is overridden to revert. Test suite expanded from 60 → 61 with 4 ownership
> tests covering 2-step transfer, cancellation, non-owner rejection, and
> renounce-blocked. Doc-vs-code drift in [docs/SECURITY.md](docs/SECURITY.md)
> is also resolved. The findings remain documented below as authored, with
> per-finding status notes reflecting the fix.

**Contracts reviewed**:
- [contracts/AjunaERC20.sol](contracts/AjunaERC20.sol) — UUPS-upgradeable ERC20 (wAJUN)
- [contracts/AjunaWrapper.sol](contracts/AjunaWrapper.sol) — UUPS-upgradeable treasury
- [contracts/Proxy.sol](contracts/Proxy.sol) — ERC1967Proxy artifact import
- [contracts/interfaces/IERC20Precompile.sol](contracts/interfaces/IERC20Precompile.sol) — Foreign-asset interface
- Mocks (test-only): [contracts/mocks/AjunaERC20V2.sol](contracts/mocks/AjunaERC20V2.sol), [contracts/mocks/AjunaWrapperV2.sol](contracts/mocks/AjunaWrapperV2.sol), [contracts/mocks/ReentrantToken.sol](contracts/mocks/ReentrantToken.sol)

**Toolchain**: Solidity 0.8.28, OpenZeppelin Contracts Upgradeable v5.x, Hardhat 2.x with `@parity/hardhat-polkadot`.

---

## Executive Summary

Since the 2026-02-15 review, no contract source files have changed (verified via `git log` — the last contract-affecting commit pre-dates the review). All prior fixes remain in place: `burnFrom`-with-allowance, `_disableInitializers()`, `_authorizeUpgrade(code.length > 0)`, `rescueToken` guards on both `foreignAsset` and `token`, max-decimals cap, `SafeERC20.safeTransfer` in rescue, and full removal of `updateForeignAsset()`.

This review focuses on areas under-covered previously: **ownership transfer semantics**, **renounce-ownership exposure**, **defense-in-depth on token interactions**, and **operational / deployment-time security** as the project moves into production with the live AJUN precompile (`0x0000002d…02200000`).

| Severity | Count | Notes |
|----------|-------|-------|
| **Critical** | 0 | — |
| **High** | 0 | — |
| **Medium** | 1 new (✅ fixed) + 1 carry-over (accepted) | M-A: switched to `Ownable2StepUpgradeable`; M-3: governance asymmetry, accepted |
| **Low** | 2 new (✅ both fixed) + 1 carry-over (accepted) | L-A: ✅ SafeERC20; L-B: ✅ `renounceOwnership` reverts; L-1: accepted |
| **Informational** | 5 (2 ✅ fixed, 3 open / accepted) | INFO-A: ✅ fail-fast; INFO-C: ✅ `isInvariantHealthy`; INFO-B (timelock), D (ED dust), E (mocks scope) — operational |

The contracts are production-ready in terms of contract logic. All actionable findings (M-A, L-A, L-B, INFO-A, INFO-C) have been fixed in code and verified by tests. The remaining concerns are operational and accepted: governance asymmetry (mitigated by multisig + timelock), redundant balance check (kept for UX), approval front-running (mitigated at the dApp layer), and INFO-B / D / E which are deployment-time runbook items rather than contract changes.

---

## 1. Status of Prior Review (2026-02-15)

All prior findings re-verified. None have regressed.

| Prior finding | Severity | Re-verified status |
|---------------|----------|--------------------|
| M-1: `rescueToken` unchecked return | Medium | ✅ Still uses `SafeERC20.safeTransfer` ([AjunaWrapper.sol:151](contracts/AjunaWrapper.sol#L151)) |
| M-2: `updateForeignAsset` + rescue bypass | Medium | ✅ `updateForeignAsset()` still absent; `foreignAsset` set-once in `initialize()` ([AjunaWrapper.sol:57-69](contracts/AjunaWrapper.sol#L57-L69)) |
| M-3: Ownable vs AccessControl asymmetry | Medium | ⚠ Accepted, still present — see §3 carry-over |
| L-1: Redundant `balanceOf` check in `withdraw` | Low | ⚠ Accepted, still present ([AjunaWrapper.sol:107-110](contracts/AjunaWrapper.sol#L107-L110)) |
| L-2: `_authorizeUpgrade` no impl validation | Low | ✅ `code.length > 0` check on both contracts |
| L-3: Rescue can extract wAJUN | Low | ✅ Block on `address(token)` present |
| L-4: No max decimals validation | Low | ✅ `decimals_ <= 18` enforced |
| L-5: ERC20 approval front-run | Low | ⚠ Industry-standard; mitigate at dApp layer |

---

## 2. New Findings

### MEDIUM-A: AjunaWrapper uses single-step `transferOwnership` — typo loses control permanently — ✅ **FIXED**

**Severity**: Medium (operational, but the failure mode is irreversible)
**File**: [contracts/AjunaWrapper.sol:30](contracts/AjunaWrapper.sol#L30)
**Status**: ✅ Fixed — `AjunaWrapper` now inherits `Ownable2StepUpgradeable`. `transferOwnership` sets a `pendingOwner`; the proposed account must call `acceptOwnership` to complete the handover. Storage layout is preserved (the new `_pendingOwner` lives at the namespaced ERC-7201 slot `openzeppelin.storage.Ownable2Step`, separate from the existing `Ownable` slot — no `__gap` consumed). Tests at [test/wrapper.test.ts](test/wrapper.test.ts) "Ownership Transfer" group cover 2-step happy path, cancellation, non-owner rejection.

`AjunaWrapper` inherits `OwnableUpgradeable`. In OpenZeppelin Contracts Upgradeable v5, this is the **single-step** owner module: `transferOwnership(newOwner)` immediately writes `_owner = newOwner` with no acceptance step. There is no built-in `Ownable2StepUpgradeable` flow on this contract.

This is confirmed by:
- The contract import at [AjunaWrapper.sol:4](contracts/AjunaWrapper.sol#L4): `import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";`
- The test at [test/wrapper.test.ts:613-626](test/wrapper.test.ts#L613-L626) explicitly notes: *"In OZ v5 OwnableUpgradeable, transferOwnership is immediate (not 2-step)"* and asserts ownership flips in one transaction.

**Why it matters**: Phase 8 of [docs/PRODUCTION-CHECKLIST.md](docs/PRODUCTION-CHECKLIST.md) requires transferring ownership to a multisig. A single typo or a wrong-but-valid address (e.g., a known-good but uncontrolled address, or a checksum mismatch silently coerced) hands control of:
- Pausing / unpausing
- Rescuing arbitrary ERC20 tokens
- **Authorizing UUPS upgrades** — i.e. replacing the entire wrapper logic, including bypassing the rescue invariant

…to whoever holds the destination address. There is no on-chain undo.

**Doc-vs-code drift**: [docs/SECURITY.md:128-138](docs/SECURITY.md#L128-L138) currently describes the transfer as a two-step `transferOwnership` + `acceptOwnership` flow. That documentation does not match the deployed contract — it describes `Ownable2StepUpgradeable` semantics that are not in use.

**Recommended fixes (pick one)**:
1. **Code fix (preferred)**: change the inheritance to `Ownable2StepUpgradeable` and replace the initializer call accordingly. This requires a UUPS upgrade (the storage layout of `Ownable2StepUpgradeable` adds a `_pendingOwner` slot which falls into the existing `__gap[48]` reserve, so no storage collision).
2. **Operational fix**: keep `OwnableUpgradeable`, but require multisig handoff to be performed via a script that (a) computes EIP-55 checksum, (b) performs a dry-run `eth_call` first, (c) optionally first transfers to an admin-controlled relay address that can re-transfer if a mistake is caught.
3. **Doc fix at minimum**: update [docs/SECURITY.md:128-138](docs/SECURITY.md#L128-L138) to remove the `acceptOwnership()` step that does not exist.

### LOW-A: `deposit` and `withdraw` interact with the foreign asset via raw `transferFrom`/`transfer` — ✅ **FIXED**

**Severity**: Low (defense-in-depth)
**Files**: [../contracts/AjunaWrapper.sol](../contracts/AjunaWrapper.sol)
**Status**: ✅ Fixed — both calls now go through `IERC20(address(foreignAsset)).safeTransferFrom(...)` and `safeTransfer(...)`. Verified by a [BadERC20](../contracts/mocks/BadERC20.sol) mock that returns `false` silently from `transfer` / `transferFrom`: `deposit` and `withdraw` both revert (without the fix, `deposit` would silently mint wAJUN with no backing, and `withdraw` would burn wAJUN without releasing AJUN).

`rescueToken` correctly uses `SafeERC20.safeTransfer`. `deposit` and `withdraw` do not — they call `foreignAsset.transferFrom(...)` and `foreignAsset.transfer(...)` directly and check the returned `bool` with `require(success, ...)`.

This is **safe today** because the AssetHub ERC20 precompile (`pallet-revive` foreign-asset wrapper) follows the standard ERC20 contract: returns `true` on success, reverts on failure. The `require(success)` line is therefore unreachable in practice.

**However**:
- The contract is UUPS-upgradeable and the `foreignAsset` address itself can be redirected via a UUPS upgrade. If a future upgrade ever points the wrapper at a non-standard ERC20 (one that returns nothing, or returns `false` on partial success rather than reverting), the current pattern is brittle.
- The inconsistency with `rescueToken`'s use of `SafeERC20` makes the codebase harder to reason about under upgrade scenarios.

**Recommendation**: switch `deposit` / `withdraw` to `IERC20(address(foreignAsset)).safeTransferFrom(...)` and `safeTransfer(...)`. SafeERC20 is already imported. No behavior change against the current AssetHub precompile.

### LOW-B: `renounceOwnership` is not overridden — accidental call permanently bricks the wrapper — ✅ **FIXED**

**Severity**: Low (requires owner-key misuse) — but the failure mode is irreversible
**File**: [contracts/AjunaWrapper.sol:30](contracts/AjunaWrapper.sol#L30)
**Status**: ✅ Fixed — `renounceOwnership()` is overridden to always revert with "AjunaWrapper: renouncing ownership is disabled" regardless of caller. Test "should block renounceOwnership for any caller" verifies both owner and non-owner are blocked, that the owner remains intact, and that admin levers (`pause`) remain operational after the attempted renounce.

`OwnableUpgradeable.renounceOwnership()` is callable by the owner and sets `_owner = address(0)`. If the wrapper's owner accidentally calls this — or a compromised key intentionally calls it as a final griefing step — the wrapper becomes:
- Permanently un-pausable
- Permanently un-rescuable
- Permanently un-upgradeable (no one can satisfy `_authorizeUpgrade(onlyOwner)`)
- The `foreignAsset` address is permanently fixed at whatever it currently is

The locked AJUN remains withdrawable by users (the user-facing flow is owner-independent), so this is not a fund-drain scenario, but it permanently disables every emergency lever in the system.

**Recommendation**: override `renounceOwnership` to revert. This is a one-line change:

```solidity
function renounceOwnership() public override onlyOwner {
    revert("AjunaWrapper: renouncing ownership disabled");
}
```

This is consistent with how the contract treats other irreversibles (e.g. `rescueToken` cannot drain the foreign asset, `_authorizeUpgrade` requires deployed code). If genuine "non-upgradability" is ever desired, a deliberate UUPS upgrade to a fixed implementation that pins `_authorizeUpgrade` to `revert()` is a more auditable path than `renounceOwnership`.

A parallel consideration applies to `AjunaERC20`: it uses `AccessControl`, where `renounceRole` is the equivalent. The deployer's renunciation of `DEFAULT_ADMIN_ROLE` and `UPGRADER_ROLE` is part of the production checklist and is the intended terminal state — only override `renounceOwnership` on the Wrapper, not the role-renunciation paths on the ERC20.

---

## 3. Carry-Over Findings (Accepted, Re-Reviewed)

### MEDIUM-3 (carry-over): AjunaWrapper uses Ownable, AjunaERC20 uses AccessControl

Status: **Accepted**, still present. The asymmetry remains: a single owner key controls pause / rescue / upgrade on the wrapper, while the ERC20 has a hierarchical role system. Mitigation per [docs/SECURITY.md](docs/SECURITY.md) is to ensure the wrapper owner is a multisig with a timelock contract in front of it. This is now reinforced by MEDIUM-A and LOW-B above — the owner key is the highest-impact key in the entire system.

### LOW-1 (carry-over): redundant `balanceOf` check in `withdraw`

Status: **Accepted**. [AjunaWrapper.sol:107-110](contracts/AjunaWrapper.sol#L107-L110) checks `token.balanceOf(msg.sender) >= amount` before calling `burnFrom`. `burnFrom` would revert anyway with OZ's `ERC20InsufficientBalance` custom error. The explicit string error is more user-friendly; the gas cost is one external `staticcall` (~2.6k gas). No security impact.

### LOW-5 (carry-over): ERC20 approval front-running

Status: **Accepted**, industry-standard. Mitigated at the dApp layer ([frontend/app.html](frontend/app.html)) by using "approve to 0, then approve to N" when changing a non-zero allowance. This is acceptable — front-running an approval requires an attacker to be a wAJUN spender authorized by the user, which by definition is the wrapper itself, which has no ability to abuse the allowance.

---

## 4. Architecture Re-Assessment

### Mint-and-Lock invariant holds

`wAJUN.totalSupply() == AJUN.balanceOf(wrapper)` is preserved by every code path in the contract:

| Path | Δ totalSupply | Δ locked AJUN | Net |
|------|---------------|---------------|-----|
| `deposit(N)` | +N | +N | invariant maintained |
| `withdraw(N)` | −N | −N | invariant maintained |
| `rescueToken(foreignAsset, ...)` | — | blocked | guard at [L148](contracts/AjunaWrapper.sol#L148) |
| `rescueToken(token, ...)` | — | — | blocked at [L149](contracts/AjunaWrapper.sol#L149) |
| `rescueToken(other, ...)` | — | — | unrelated |
| Direct AJUN transfer to wrapper | — | +N | over-collateralized (safe) |
| Pause / unpause | frozen | frozen | invariant frozen |
| UUPS upgrade | — | — | preserved by proxy storage |

The only way to break the invariant from contract logic alone is via a UUPS upgrade that introduces a malicious code path — which requires the wrapper owner key. This re-emphasizes the importance of multisig + timelock for the owner.

### CEI ordering

`deposit` does external `transferFrom` before internal `mint`; `withdraw` does internal `burnFrom` before external `transfer`. Both are protected by `nonReentrant`. The deposit ordering is not strict checks-effects-interactions, but with the reentrancy guard it is correct: a re-entrant call is mutex-blocked, and the `mint` cannot run before `transferFrom` completes. The reentrancy test at [test/wrapper.test.ts:813-844](test/wrapper.test.ts#L813-L844) using [ReentrantToken.sol](contracts/mocks/ReentrantToken.sol) explicitly exercises this and passes.

### UUPS upgrade authorization

Both contracts implement `_authorizeUpgrade` correctly:
- [AjunaERC20.sol:86-88](contracts/AjunaERC20.sol#L86-L88): `onlyRole(UPGRADER_ROLE)` + `code.length > 0`
- [AjunaWrapper.sol:162-164](contracts/AjunaWrapper.sol#L162-L164): `onlyOwner` + `code.length > 0`

`upgradeToAndCall` (inherited from OZ `UUPSUpgradeable`) additionally calls `proxiableUUID()` on the new implementation via `ERC1967Utils.upgradeToAndCallUUPS`, so the `code.length > 0` check is layered defense rather than the only check. EOA upgrades and non-UUPS upgrades are both rejected — this is verified by the upgrade-EOA tests at [test/wrapper.test.ts:506-518](test/wrapper.test.ts#L506-L518).

### Storage-layout safety under upgrade

OZ Contracts Upgradeable v5 uses **ERC-7201 namespaced storage** for inherited base contracts. Each base lives at a hashed slot, eliminating cross-base collision. Derived state on `AjunaERC20` and `AjunaWrapper` therefore starts at slot 0 and is followed by `__gap` reserves of 49 and 48 slots respectively. This is correct and verified by the V2 migration tests at [test/wrapper.test.ts:520-605](test/wrapper.test.ts#L520-L605).

---

## 5. Attack Surface Matrix

### Untrusted-caller paths (any EOA / contract)

| Vector | Mechanism | Mitigation |
|--------|-----------|------------|
| Mint without authorization | Call `AjunaERC20.mint` | `onlyRole(MINTER_ROLE)` — only the wrapper holds it |
| Burn without authorization | Call `AjunaERC20.burnFrom` | `onlyRole(MINTER_ROLE)` + `_spendAllowance` (allowance from holder required) |
| Reentrancy on deposit | Malicious foreign-asset `transferFrom` callback | `nonReentrant` modifier — verified by mock-attacker test |
| Reentrancy on withdraw | Malicious foreign-asset `transfer` callback | `nonReentrant` modifier |
| Withdraw without backing | Call `withdraw(N)` with no wAJUN | balance check + `burnFrom` reverts |
| Withdraw without approval | Call `withdraw(N)` with no wAJUN approval | `_spendAllowance` reverts |
| Re-initialize the proxy | Call `initialize` again | `initializer` modifier (one-shot) |
| Initialize the implementation directly | Call `initialize` on impl contract | `_disableInitializers()` in constructor |
| Upgrade without authorization | Call `upgradeToAndCall` | `UPGRADER_ROLE` / `onlyOwner` + `code.length > 0` + `proxiableUUID()` |
| Front-run approval | Standard ERC20 race | dApp uses "zero-then-set" pattern |
| Flash-loan / leverage | Borrow AJUN, deposit, exit before repay | Not exploitable — wrap is 1:1, no yield, no price oracle |

### Privileged-key paths

| Key | Worst-case action | New finding |
|-----|-------------------|-------------|
| AjunaWrapper owner | Pause forever (DoS); rescue any non-AJUN/non-wAJUN token; **upgrade to malicious impl that drains everything**; **transfer ownership to wrong address** | M-A (1-step transfer) |
| AjunaWrapper owner | **Renounce ownership and brick all admin levers** | L-B |
| AjunaERC20 admin | Grant `MINTER_ROLE` to attacker → unlimited wAJUN minting (breaks invariant) | unchanged |
| AjunaERC20 upgrader | Upgrade ERC20 to remove burn restriction → drain user wAJUN | unchanged |

The wrapper-owner row is the highest concentration of risk in the system. Multisig + timelock is non-negotiable for production.

---

## 6. Operational / Deployment-Time Findings

### INFO-A: Hardhat config silently falls back to a zero PRIVATE_KEY — ✅ **FIXED**

**File**: [../hardhat.config.ts](../hardhat.config.ts)
**Status**: ✅ Fixed — config now throws at load time when `HARDHAT_NETWORK` is one of `polkadotMainnet` / `polkadotTestnet` and no `PRIVATE_KEY` Hardhat var is set. Compile / test / in-memory-hardhat flows are unaffected because they don't set `HARDHAT_NETWORK`.

### INFO-B: No on-chain timelock on owner / UPGRADER_ROLE

[docs/SECURITY.md:380](docs/SECURITY.md#L380) lists "Timelock contract deployed in front of multisig (recommended: 24–48h delay)" as a hardening item. As of this review the project does not provide a Timelock deployment script. For production, a `TimelockController` (OpenZeppelin) in front of the multisig is the standard pattern. Any UUPS upgrade — the most catastrophic privileged action in the system — should pass through the timelock so users have time to exit.

### INFO-C: No real-time invariant monitor — ✅ **FIXED**

**Status**: ✅ Fixed — `isInvariantHealthy()` added to `AjunaWrapper` as an `external view` returning whether `wAJUN.totalSupply() == AJUN.balanceOf(wrapper)`. Tests cover fresh-wrapper, post-deposit, post-withdraw, and the over-collateralized path (third party direct-transfers AJUN to the wrapper without depositing — strict equality returns `false`, which is the correct signal for monitors to investigate even though it's not an under-backed condition).

```solidity
function isInvariantHealthy() external view returns (bool) {
    return token.totalSupply() == foreignAsset.balanceOf(address(this));
}
```

Off-chain monitors should still run their own checks. The view is a convenience for dashboards and on-chain liveness probes.

### INFO-D: Existential-deposit reaping risk for the AJUN asset account

The wrapper holds AJUN as a `pallet-foreign-assets` account. If the wrapper's AJUN balance ever drops to zero (all users withdraw fully), the asset account is reaped and the next deposit may behave unexpectedly. [docs/PRODUCTION-CHECKLIST.md](docs/PRODUCTION-CHECKLIST.md) Phase 6B already mandates seeding the wrapper with permanent AJUN dust. This is sufficient — flagging here so the operational requirement isn't lost in a frontend/UI-focused sub-team.

### INFO-E: Single test file, but mock contracts are excluded from production deployment

[test/wrapper.test.ts](test/wrapper.test.ts) (61 tests) imports from [contracts/mocks/](contracts/mocks/). Those mock contracts (`AjunaERC20V2`, `AjunaWrapperV2`, `ReentrantToken`) compile alongside production contracts. They are not referenced by any deployment script and are not in the deploy path, but their bytecode is in the [artifacts/](artifacts/) tree. Recommend adding a comment in [contracts/mocks/](contracts/mocks/) that these are test-only, and ensuring no deployment script ever instantiates them on a live network. (The current scripts do not — verified.)

---

## 7. Test Coverage Re-Assessment

The suite is comprehensive (61 tests across deployment, deposit, withdraw, access control, pausable, rescue, multi-user, UUPS, ownership, role management, rescue edge cases, pause edge cases, zero-amount edge cases, reentrancy, event validation, and V2 migrations). The reentrancy test exercises a real attacker mock; the V2 upgrade tests exercise actual storage migration with `reinitializer(2)` and verify state preservation.

### Coverage gaps worth filling

| Test | Why | Priority |
|------|-----|----------|
| Owner accidentally calls `renounceOwnership` → all admin functions blocked | Validates LOW-B fix once applied | High (after fix) |
| `transferOwnership(wrongAddress)` → original owner is locked out | Validates MEDIUM-A is real and motivates Ownable2Step | High |
| Foreign asset returns `false` (no revert) on `transferFrom` | Validates LOW-A: current code does revert via require, but the path is exercised | Medium |
| `upgradeToAndCall` to a non-UUPS contract (no `proxiableUUID`) | Validates the OZ-internal UUPS check | Low |
| Max-uint deposit / withdraw | Overflow edge | Low |

---

## 8. Recommendations Summary

### Should fix before mainnet handoff to multisig

| # | Finding | Action | Status |
|---|---------|--------|--------|
| M-A | 1-step `transferOwnership` is risky for the most powerful key in the system | Switched to `Ownable2StepUpgradeable` | ✅ Fixed |
| L-B | `renounceOwnership` permanently bricks admin levers | Override to `revert()` | ✅ Fixed |

### Defense-in-depth, lower priority

| # | Finding | Action |
|---|---------|--------|
| L-A | Use `SafeERC20` consistently in `deposit` / `withdraw` | ✅ Fixed — both calls go through `safeTransferFrom` / `safeTransfer`; verified with `BadERC20` mock |
| INFO-A | Hardhat config silently falls back to zero key on production networks | ✅ Fixed — config throws at load time when `HARDHAT_NETWORK` is `polkadotMainnet` / `polkadotTestnet` and `PRIVATE_KEY` is unset |
| INFO-B | No timelock | Deploy `TimelockController` between multisig and the wrapper / ERC20 admin actions (operational, not contract change) |
| INFO-C | No on-chain invariant view | ✅ Fixed — `isInvariantHealthy()` external view added |

### Documentation

| File | Drift | Fix |
|------|-------|-----|
| [docs/SECURITY.md:128-138](docs/SECURITY.md#L128-L138) | Describes `acceptOwnership()` two-step flow that does not exist on current contract | Either implement Ownable2Step (preferred) or remove the `acceptOwnership` step from the doc |

---

## 9. Production-Readiness Verdict

The contracts themselves are **ready for mainnet deployment**. All prior critical and high-severity findings remain fixed, and the two new medium/low findings (M-A and L-B) identified in this review have been **fixed in code on the same day**:

- **M-A → fixed**: `AjunaWrapper` now inherits `Ownable2StepUpgradeable`. Multisig handoff requires the multisig to call `acceptOwnership()` before it takes effect — a typo or wrong-address mistake at `transferOwnership` time can be cancelled by re-calling with the correct address.
- **L-B → fixed**: `renounceOwnership()` reverts for any caller. The wrapper's admin levers (pause, rescue, upgrade authorization) cannot be accidentally or maliciously discarded.
- **Test suite**: 60 → 61 tests, with 4 ownership tests covering the new flows (2-step happy path, pending-transfer cancellation, non-owner rejection, renounce blocked for any caller).

Recommended sequence for the imminent mainnet rollout:
1. ✅ Apply M-A and L-B in code — done.
2. ✅ Update + re-run the full test suite — done (61/61 passing).
3. Deploy the patched implementation as the **fresh** wrapper (this is a fresh production deploy, not an upgrade of an existing live contract).
4. Run a smoke test: `transferOwnership(testAddress)` → confirm `pendingOwner() == testAddress` and `owner()` unchanged → `acceptOwnership()` from `testAddress` → confirm transfer completes → transfer back. This validates the 2-step flow on production before handing control to the multisig.
5. Proceed with [docs/PRODUCTION-CHECKLIST.md](docs/PRODUCTION-CHECKLIST.md) Phases 8–12. The multisig handoff itself now benefits from the 2-step protection. Phase 11 (Open To Public) flips the new allowlist gate off.

All actionable contract-level findings (M-A, L-A, L-B, INFO-A, INFO-C) are now fixed and tested. The remaining items (INFO-B timelock, INFO-D existential-deposit dust, INFO-E mocks-scope) are operational / runbook concerns covered by [docs/PRODUCTION-CHECKLIST.md](PRODUCTION-CHECKLIST.md), not contract changes.
