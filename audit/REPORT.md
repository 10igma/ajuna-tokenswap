# Ajuna Tokenswap — Independent Security Audit

**Verdict:** *Acceptable for staged mainnet rollout, with the recommendations in §7 applied before disabling the allowlist gate.*

> **Update (post-audit, same-day)**: All §7 Tier-1 (must-fix), Tier-2
> (should-fix), and Tier-3 (hardening) recommendations have been
> implemented. ATS-01, ATS-02, ATS-03, ATS-04, ATS-05, ATS-06, ATS-07,
> ATS-08, ATS-09, ATS-10, ATS-11, ATS-12, ATS-14 — all closed. Test
> suite grew 91 → 112. `npx --yes @openzeppelin/upgrades-core validate
> artifacts/build-info` now passes (was: 4 failing). Each finding below
> carries a per-section ✅ / ⚠ status update.

The system has no Critical findings and no High findings under standard EVM trust assumptions. The dominant risk classes are (a) operational hand-off divergence between two reference deployment paths, (b) unenforced coupling between two roles whose divergence can break the backing invariant, and (c) a small set of upgrade-hygiene issues whose impact is currently latent but would activate on a future OZ dependency bump or a non-careful V2 deployment.

---

## 1. Executive summary

### 1.1 System (as I read it)

`AjunaWrapper` is a UUPS-upgradeable, owner-administered, pause-able treasury that wraps an AssetHub Foreign-Asset (AJUN, exposed via a `pallet-revive` ERC20 precompile) into a UUPS-upgradeable ERC20 (`AjunaERC20` / wAJUN) at strict 1:1. Users deposit AJUN by pulling it into the wrapper via `safeTransferFrom` and receiving wAJUN minted by the wrapper (which holds `MINTER_ROLE` on the ERC20). They redeem by approving the wrapper to `burnFrom` their wAJUN and receiving AJUN back via `safeTransfer`. An owner-controlled deposit-only allowlist gates initial production rollout and can be flipped off in one transaction. The single core invariant the system advertises is `wAJUN.totalSupply() == AJUN.balanceOf(wrapper)`.

### 1.2 Severity counts

| Critical | High | Medium | Low | Informational | Gas |
|----------|------|--------|-----|--------------|-----|
| 0 | 0 | 3 | 4 | 8 | 1 |

### 1.3 Top three risks

1. **ATS-01 — Broken post-deploy hand-off in `scripts/deploy_production.sh`.** The script tells operators to call `grantRole(DEFAULT_ADMIN_ROLE, multisig)` and `renounceRole(DEFAULT_ADMIN_ROLE, deployer)`, both of which the contract code rejects (the ERC20 uses `AccessControlDefaultAdminRulesUpgradeable`). An operator who runs only the script without cross-referencing `docs/PRODUCTION-CHECKLIST.md` ends Phase 9 with the deployer EOA still holding the highest-privilege role on the ERC20 — and that role can grant `MINTER_ROLE` to anyone, which directly breaks the 1:1 backing invariant.
2. **ATS-04 — Unenforced coupling between `wrapper.owner()` and `erc20.defaultAdmin()`.** The contracts trust off-chain operators to keep these aligned, but nothing in the code requires it. PoC: a deployment that hands the wrapper to the multisig but the ERC20 to a different (or compromised) address allows the ERC20 admin to grant themselves `MINTER_ROLE` and mint unbacked wAJUN, breaking the invariant. The production checklist names this as an off-chain monitor in Phase 9C; it should be enforced on-chain or, at minimum, made impossible to forget.
3. **ATS-09 — `AjunaWrapper` inherits the *non-upgradeable* `ReentrancyGuard`.** OZ `upgrades-core` flags this as a build-time error; the standard `hardhat-upgrades` plugin would refuse to deploy or upgrade. Behaviour today is safe only by accident (the proxy storage at the namespaced slot starts at 0, which is not equal to `ENTERED == 2`), and the same inheritance choice is fragile across OZ versions — the v6.0 swap to `ReentrancyGuardTransient` would silently change semantics, and PVM (`pallet-revive`) EIP-1153 transient-storage support is not specified by the contract assumption.

### 1.4 Posture verdict

**Acceptable for staged mainnet rollout.** The contracts themselves are tight: the deposit/withdraw paths are correctly ordered, fee-on-transfer-safe, reentrancy-guarded, pause-respecting, and SafeERC20-clean. The `Ownable2Step`+`AccessControlDefaultAdminRules` typo-resistance is real and tested. The allowlist gate is well-designed (deposit-only, owner-implicitly-allowed, withdraw-permissionless even with the gate up).

The risk concentration is in the *operational* perimeter: deployment scripts, hand-off documentation, V2 upgrade templates, and the unenforced role-coupling between the two contracts. None of these block initial mainnet deployment under the allowlist gate, but ATS-01, ATS-02, ATS-03, and ATS-04 should be resolved before the allowlist is disabled in Phase 11.

---

## 2. Methodology

| Activity | What | Result |
|----------|------|--------|
| Manual review | Read each in-scope contract end-to-end at least twice; line-by-line on `deposit`, `withdraw`, `_authorizeUpgrade`, `initialize`. | See findings §4. |
| Test-suite execution | `npx hardhat test` — baseline 91 tests; added `test/audit/*` with 7 PoC tests (98 total passing). | Baseline green; PoCs green for ATS-02, ATS-04, ATS-06, ATS-09, ATS-11. |
| Storage layout | Compiled with `outputSelection.storageLayout = ["storageLayout"]`, dumped slot map directly from solc 0.8.30 output. Cross-referenced against contract comments and `docs/`. | See `audit/storage-layout.md`. |
| OZ upgrades-core | `npx --yes @openzeppelin/upgrades-core validate artifacts/build-info` | FAILED on `AjunaWrapper` and `AjunaWrapperV2` (ATS-09). |
| Slither | `slither-analyzer 0.11.5` with default + all detectors. | Only the intentional strict-equality on `isInvariantHealthy()`; no high-impact findings on production code. |
| Doc cross-check | Compared `docs/SECURITY.md`, `docs/ARCHITECTURE.md`, `docs/UPGRADE.md`, `docs/PRODUCTION-CHECKLIST.md`, `scripts/deploy_production.sh` against the contract code; trusted the code where they diverge. | ATS-01, ATS-02, ATS-06, ATS-08. |
| PVM specifics | Flagged code that depends on EVM-specific opcode semantics (`extcodesize`, `SELFDESTRUCT`, EIP-1153). No PVM specification document in repo. | ATS-09, ATS-10, T3 in threat model. |
| Tools attempted but unused | Aderyn (not installed), Mythril (low ROI), Echidna/Foundry fuzz (recommended in §6). | See `audit/tools.log`. |

Threat model ([audit/threat-model.md](threat-model.md)) was built first and used to scope each finding's "Affected actors" line.

---

## 3. System description

### 3.1 Actors

The actor matrix is enumerated in full in [audit/threat-model.md](threat-model.md). Summary:

| ID | Actor | Power level |
|----|-------|-------------|
| A1 | Honest user | none beyond own funds |
| A2 | Greedy/curious user | mempool monitoring |
| A3 | Allowlisted attacker | A1 + deposit-while-gated |
| A4 | Pre-handoff deployer EOA | full system compromise — holds all roles |
| A5 | Post-handoff multisig (wrapper owner) | pause/rescue/upgrade/transferOwnership |
| A6 | Pending owner mid-transfer | none until acceptance |
| A7 | `MINTER_ROLE` holder | mint/burn — can break backing |
| A8 | `UPGRADER_ROLE` holder | replace ERC20 logic |
| A9 | `DEFAULT_ADMIN_ROLE` holder | grant any role on ERC20 |
| A10 | Holder of a malicious upgrade impl | full takeover post-upgrade |
| A11 | Self-destructible impl | bricks proxy if PVM allows code clearing |
| A12 | Substrate runtime (account reaping) | locks AJUN if ED not seeded |
| A13 | Frontend-poisoning attacker | approval phishing |
| A14 | Malicious foreign asset (init-time mistake) | bypass via balance/transfer lies |

### 3.2 State machine

```
                ┌─────────────────┐
        deploy  │  Implementations│   (constructor: _disableInitializers)
                └────────┬────────┘
                         │
            new ERC1967Proxy(impl, encodeCall(initialize, …))
                         ▼
   ┌──────── INITIALIZED, owner=deployer, allowlistEnabled=true ────────┐
   │                                                                    │
   │ owner: setAllowlist(*) / setAllowlistBatch(*) / setAllowlistEnabled│
   │ owner: pause() ──► PAUSED ──► owner: unpause() ──► back here       │
   │ owner: rescueToken(token != foreignAsset, != wAJUN, to, amount)    │
   │ owner: transferOwnership(newOwner) ──► PENDING_OWNER               │
   │   pending: acceptOwnership() ──► OWNER=newOwner                    │
   │   owner: transferOwnership(0) cancels pending                      │
   │ owner: upgradeToAndCall(newImpl, data) ──► IMPLEMENTATION REPLACED │
   │ owner: renounceOwnership() — REVERTS (override)                    │
   │ user (allowlisted or owner): deposit(amount) ──► +amount AJUN, +amount wAJUN │
   │ user (any): withdraw(amount) ──► -amount AJUN, -amount wAJUN       │
   │   (withdraw is NOT gated by allowlist; only by pause)              │
   └────────────────────────────────────────────────────────────────────┘
```

### 3.3 Admin levers

| Lever | Caller | Scope | Reversible | Pausable bypass | Allowlist bypass |
|-------|--------|-------|-----------|-----------------|-----------------|
| `pause` / `unpause` | `onlyOwner` | block deposit/withdraw | yes | n/a | yes (admin) |
| `setAllowlistEnabled(bool)` | `onlyOwner` | gate deposit | yes | yes (callable while paused) | n/a |
| `setAllowlist(addr, bool)` | `onlyOwner` | per-account | yes | yes | n/a |
| `setAllowlistBatch(addrs, bool)` | `onlyOwner` | bulk | yes | yes | n/a |
| `transferOwnership(addr)` | `onlyOwner` | start two-step | yes (re-call with another addr) | yes | n/a |
| `acceptOwnership()` | new owner | finalize | no | yes | n/a |
| `rescueToken(t, to, amount)` | `onlyOwner` | extract stray ERC20s; cannot rescue `foreignAsset` or `token` | n/a | yes | n/a |
| `upgradeToAndCall(impl, data)` | `onlyOwner` | replace logic; `impl.code.length > 0` required | yes (forward upgrade only) | yes | n/a |
| `grantRole(MINTER_ROLE, addr)` (ERC20) | `DEFAULT_ADMIN_ROLE` | add minter | yes | n/a | n/a |
| `revokeRole(MINTER_ROLE, addr)` (ERC20) | `DEFAULT_ADMIN_ROLE` | remove minter | yes | n/a | n/a |
| `grantRole(UPGRADER_ROLE, addr)` (ERC20) | `DEFAULT_ADMIN_ROLE` | add upgrader | yes | n/a | n/a |
| `beginDefaultAdminTransfer(addr)` (ERC20) | `DEFAULT_ADMIN_ROLE` | start delayed transfer | yes (`cancelDefaultAdminTransfer`) | n/a | n/a |
| `acceptDefaultAdminTransfer()` (ERC20) | new admin (after delay) | finalize | no | n/a | n/a |
| `upgradeToAndCall` (ERC20) | `UPGRADER_ROLE` | replace ERC20 logic | yes | n/a | n/a |

### 3.4 Asset flows

Both flows are atomic at the EVM level — a partial transferFrom plus mint cannot be split across blocks. The deposit pull-then-balance-delta pattern (lines 170–184 in `AjunaWrapper.sol`) defends against future fee-on-transfer or rebasing semantics on the precompile by minting the *received* delta rather than the *requested* amount. The withdraw burn-then-transfer ordering ensures that a `safeTransfer` revert rolls back the burn, preserving the invariant.

---

## 4. Findings

> Severity rubric per the engagement brief. Severities are this auditor's call and may differ from `docs/SECURITY.md`.

### ATS-01 — `scripts/deploy_production.sh` instructs operations that the contract rejects, leaving the deployer EOA holding `DEFAULT_ADMIN_ROLE` — ✅ **FIXED**

> **Status (post-audit)**: ✅ Fixed. The `echo`-block in `scripts/deploy_production.sh` Phase 4/5 now spells out the two-step + delayed flow (`grantRole(UPGRADER_ROLE)`, `beginDefaultAdminTransfer`, wait, `acceptDefaultAdminTransfer`, then renounce `UPGRADER_ROLE`). The two prior step lines that revert against the contract are explicitly flagged as such in the printout.

| | |
|---|---|
| ID | ATS-01 |
| Title | Production deploy helper contradicts `AccessControlDefaultAdminRules` and `Ownable2Step` |
| Severity | **Medium** |
| Likelihood | High (script is the documented Option A in `docs/PRODUCTION-CHECKLIST.md` Phase 4) |
| Impact | Medium (silent failure; recoverable via the more accurate checklist; broken invariant only if the deployer is later compromised before the operator notices) |
| Status | Open |
| Location | `scripts/deploy_production.sh:71-82`; cross-references `contracts/AjunaERC20.sol:25` and OZ `AccessControlDefaultAdminRulesUpgradeable` |
| Category | Spec Mismatch / Operational |

**Description.** The post-deploy section of the production helper script tells the operator to perform two ERC20 admin transfers using single-step `grantRole` / `renounceRole`:

```
4. TRANSFER ROLES — Move admin roles to multisig/governance:
     AjunaERC20: grantRole(DEFAULT_ADMIN_ROLE, multisig)        ← REVERTS
     AjunaERC20: grantRole(UPGRADER_ROLE, multisig)             ← OK
     AjunaWrapper: transferOwnership(multisig)                  ← OK (begins two-step)
5. RENOUNCE DEPLOYER ROLES:
     AjunaERC20: renounceRole(DEFAULT_ADMIN_ROLE, deployer)     ← REVERTS
     AjunaERC20: renounceRole(UPGRADER_ROLE, deployer)          ← OK
```

The ERC20 inherits `AccessControlDefaultAdminRulesUpgradeable`, which (a) blocks direct `grantRole(DEFAULT_ADMIN_ROLE, …)` — the correct flow is `beginDefaultAdminTransfer` then `acceptDefaultAdminTransfer` after the delay — and (b) blocks direct `renounceRole(DEFAULT_ADMIN_ROLE, …)` unless a transfer has already been begun with `address(0)`. Both calls revert. The repo's own test suite covers this at `test/wrapper.test.ts:1315-1369`.

The result of an operator following only the script is that the wrapper transfers ownership correctly (Phase 8B in the checklist is fine), but the ERC20's `DEFAULT_ADMIN_ROLE` remains on the deployer EOA. That role can grant `MINTER_ROLE` to any address, which is the single most direct way to break the 1:1 backing invariant — see ATS-04 PoC.

**Attack scenario (passive, no attacker required).**
1. Operator runs `./scripts/deploy_production.sh` per Phase 4 Option A.
2. Operator follows the printed post-deploy checklist verbatim.
3. Steps "grantRole(DEFAULT_ADMIN_ROLE, multisig)" and "renounceRole(DEFAULT_ADMIN_ROLE, deployer)" revert. The operator may interpret the reverts as "the chain is busy, retry later" or "EVM gas/permission problem" rather than "this instruction is wrong."
4. Even if the operator notices and consults `docs/PRODUCTION-CHECKLIST.md` Phase 8A/9A, there is now a window of unknown duration where the deployer EOA holds `DEFAULT_ADMIN_ROLE`. Compromise of the deployer key during this window enables the next step.
5. (Active variant.) The compromised deployer key calls `token.grantRole(MINTER_ROLE, attacker)` and `token.mint(attacker, 1e30)`. The 1:1 backing invariant breaks.

**Proof / PoC.** `test/audit/spec_mismatch.test.ts:14-58` (ATS-02 sub-tests in the file) shows both calls revert against the production contract.

```ts
await expect(
  token.connect(deployer).grantRole(DEFAULT_ADMIN_ROLE, multisig.address)
).to.be.reverted;

await expect(
  token.connect(deployer).renounceRole(DEFAULT_ADMIN_ROLE, deployer.address)
).to.be.reverted;
```

Run:

```
$ npx hardhat test test/audit/spec_mismatch.test.ts
✔ step 4 (grantRole(DEFAULT_ADMIN_ROLE, multisig)) reverts
✔ step 5 (renounceRole(DEFAULT_ADMIN_ROLE, deployer)) reverts when no transfer is pending
```

**Affected actors.** A4 (pre-handoff deployer), trust assumption T7. Indirectly enables A9 if the deployer key is later compromised.

**Recommendation.** Replace the script's post-deploy block with the correct flow, and have it print a hard error if the user attempts step 4/5 verbatim:

```diff
-  AjunaERC20: grantRole(DEFAULT_ADMIN_ROLE, multisig)
-  AjunaERC20: grantRole(UPGRADER_ROLE, multisig)
-  AjunaWrapper: transferOwnership(multisig)
+  # ERC20 admin transfer is two-step + delayed (see PRODUCTION-CHECKLIST.md Phase 8A/9A):
+  AjunaERC20: grantRole(UPGRADER_ROLE, multisig)
+  AjunaERC20: beginDefaultAdminTransfer(multisig)
+  # Wait the configured delay (production: 5 days). Then the multisig:
+  AjunaERC20.connect(multisig): acceptDefaultAdminTransfer()
+  AjunaWrapper: transferOwnership(multisig)
+  AjunaWrapper.connect(multisig): acceptOwnership()

   AjunaERC20: renounceRole(UPGRADER_ROLE, deployer)
-  AjunaERC20: renounceRole(DEFAULT_ADMIN_ROLE, deployer)
+  # DEFAULT_ADMIN_ROLE was atomically moved to multisig in Phase 9A; no separate renunciation needed.
```

Better still: have the script *call* the right transactions itself (with explicit confirmation prompts) instead of printing them. Operators copy-paste; the documentation must not be mistakeable.

**References.** OZ `AccessControlDefaultAdminRulesUpgradeable` (v5.6.1). Cross-link to ATS-02, ATS-04.

---

### ATS-02 — `docs/UPGRADE.md` "Making a Contract Non-Upgradeable" instructs operations that the wrapper rejects — ✅ **FIXED**

> **Status (post-audit)**: ✅ Fixed. `docs/UPGRADE.md` "Making a Contract Non-Upgradeable" now describes the two-step `beginDefaultAdminTransfer(address(0))` + delay + `renounceRole` flow for `DEFAULT_ADMIN_ROLE`, and explicitly says `wrapper.renounceOwnership()` is permanently disabled (with a pointer to the "Alternative" section that uses a UUPS upgrade to a final implementation).

| | |
|---|---|
| ID | ATS-02 |
| Title | Documented "make non-upgradeable" recipe contradicts `renounceOwnership` override and `DEFAULT_ADMIN_ROLE` rules |
| Severity | Low |
| Likelihood | Low (this section is invoked only at end-of-life of the contract) |
| Impact | Low (failed call leaves contract in same state — fail-closed) |
| Status | Open |
| Location | `docs/UPGRADE.md:482-498`; `contracts/AjunaWrapper.sol:276-278` |
| Category | Spec Mismatch |

**Description.** `docs/UPGRADE.md` lines 482–498 instruct operators to "renounce" upgradeability with two calls:

```solidity
// AjunaERC20:
token.renounceRole(UPGRADER_ROLE, multisigAddress);
token.renounceRole(DEFAULT_ADMIN_ROLE, multisigAddress);
// AjunaWrapper:
wrapper.renounceOwnership();
```

`token.renounceRole(DEFAULT_ADMIN_ROLE, …)` is blocked by `AccessControlDefaultAdminRulesUpgradeable` unless a `beginDefaultAdminTransfer(address(0))` was scheduled first. `wrapper.renounceOwnership()` reverts unconditionally because the wrapper overrides it (`AjunaWrapper.sol:276-278`):

```solidity
function renounceOwnership() public pure override {
    revert("AjunaWrapper: renouncing ownership is disabled");
}
```

**Attack scenario.** Operator decides to permanently freeze the contract per the docs. The `wrapper.renounceOwnership()` call reverts. The operator either gives up (system continues to be upgradeable, no harm done) or works around the override by following the docs' alternative path (deploy an implementation with `_authorizeUpgrade` reverting). Either way no funds are at risk; the documented and implemented behaviours have simply diverged.

**Proof.** Existing repo test `test/wrapper.test.ts:674-685` confirms `wrapper.renounceOwnership()` always reverts. The DEFAULT_ADMIN renunciation flow is covered at `test/wrapper.test.ts:1354-1369`.

**Affected actors.** Trust assumption T8 (operational discipline).

**Recommendation.** In `docs/UPGRADE.md`, replace the "Renouncing Ownership Is Disabled / Renounce" subsection with the documented alternative path:

```diff
-### For AjunaERC20
-Renounce `UPGRADER_ROLE` from all holders:
-```solidity
-token.renounceRole(UPGRADER_ROLE, multisigAddress);
-token.renounceRole(DEFAULT_ADMIN_ROLE, multisigAddress);
-```
-
-### For AjunaWrapper
-Renounce ownership:
-```solidity
-wrapper.renounceOwnership();
-```
+### For AjunaERC20
+1. Renounce `UPGRADER_ROLE` from all holders. To renounce `DEFAULT_ADMIN_ROLE`,
+   first `beginDefaultAdminTransfer(address(0))`, wait the configured delay,
+   then `renounceRole(DEFAULT_ADMIN_ROLE, currentAdmin)`. See
+   `test/wrapper.test.ts` "requires a two-step renunciation of DEFAULT_ADMIN_ROLE".
+
+### For AjunaWrapper
+`renounceOwnership()` is permanently disabled by override. To make the wrapper
+immutable, deploy a new implementation that overrides `_authorizeUpgrade` to
+always revert (see "Alternative" below) and upgrade to it.
```

---

### ATS-03 — V2 mock migration functions are unauthenticated and would publish a front-runnable upgrade pattern — ✅ **FIXED**

> **Status (post-audit)**: ✅ Fixed. `AjunaWrapperV2.migrateToV2` now carries `onlyOwner`; `AjunaERC20V2.migrateToV2` now carries `onlyRole(UPGRADER_ROLE)`. Audit PoC tests updated to verify the access control.

| | |
|---|---|
| ID | ATS-03 |
| Title | `AjunaWrapperV2.migrateToV2()` and `AjunaERC20V2.migrateToV2()` lack access control |
| Severity | Medium (if used as production V2 template) / Low (if confined to tests) |
| Likelihood | Low (requires copy-paste into production) |
| Impact | Medium (front-runnable migration → wrong state at upgrade time) |
| Status | Open |
| Location | `contracts/mocks/AjunaWrapperV2.sol:16-18`; `contracts/mocks/AjunaERC20V2.sol:16-18`; cross-reference `docs/UPGRADE.md:144-158` (which gets the access-control right) |
| Category | Upgradeability / Initialization |

**Description.** Both V2 mocks expose:

```solidity
function migrateToV2() external reinitializer(2) {
    version = 2;
}
```

The `reinitializer(2)` modifier makes the function callable exactly once after the upgrade — but with **no access control**. Any address can call it. The expected production pattern (correctly shown in `docs/UPGRADE.md:144-158`) gates migration with `onlyRole(UPGRADER_ROLE)` or `onlyOwner`.

The mocks are *also* the templates documented at the top of `docs/UPGRADE.md` ("V2 contract", "Template: AjunaWrapperV2"). Because the in-tree mocks are simpler than the docs (they omit the role guard), a future contributor who copies `contracts/mocks/AjunaWrapperV2.sol` as the starting point for a production V2 will inherit the omission.

**Attack scenario.**
1. Multisig calls `wrapper.upgradeToAndCall(v2Impl, "0x")` — i.e. *not* the recommended atomic `upgradeToAndCall(v2Impl, encodeCall(this.migrateToV2, ()))`.
2. The upgrade tx confirms. The proxy now points at V2, but `version` is still 0 because `migrateToV2` has not run.
3. Attacker (anyone watching the chain) calls `wrapperV2.migrateToV2()` ahead of the multisig's planned follow-up.
4. The migration runs with attacker's `msg.sender`. For this trivial mock the only effect is `version = 2` (harmless), but for a real V2 that initializes fee parameters, recipient addresses, or treasury splits inside `migrateToV2`, the attacker's transaction would set those values — using *attacker-controlled* arguments if the function takes any.

The PoC test (`test/audit/spec_mismatch.test.ts:80-130`) shows the attacker successfully calling `migrateToV2` after the upgrade.

**Proof.** `test/audit/spec_mismatch.test.ts`:

```ts
await (wrapper as any).connect(owner).upgradeToAndCall(await v2Impl.getAddress(), "0x");
// Attacker (any address) finalizes the migration:
await (wrapperV2 as any).connect(attacker).migrateToV2();
expect(await (wrapperV2 as any).version()).to.equal(2);
```

Both wrapper and ERC20 V2 mocks reproduce the issue.

**Affected actors.** A2 (greedy user) becomes the migration caller.

**Recommendation.** Either delete the mock V2s' migration function entirely (rely on the upgrades plugin for testing) or — preferred for didactic value — add the same role guard the production template uses:

```diff
- function migrateToV2() external reinitializer(2) {
+ function migrateToV2() external reinitializer(2) onlyOwner {       // wrapper
+ function migrateToV2() external reinitializer(2) onlyRole(UPGRADER_ROLE) {  // erc20
      version = 2;
  }
```

Update `docs/UPGRADE.md` to point at the in-tree mocks as the canonical template only after this fix lands.

---

### ATS-04 — `wrapper.owner()` and `erc20.defaultAdmin()` are not coupled by code; divergence permits the ERC20 admin to mint unbacked wAJUN — ✅ **FIXED (on-chain)**

> **Status (post-audit)**: ✅ Fixed via the audit's preferred "strong enforcement" path. `AjunaERC20.bindMinter(address)` is a one-shot called by `DEFAULT_ADMIN_ROLE` that atomically sets `boundMinter = wrapper` and grants `MINTER_ROLE`. `_grantRole` is overridden to require any subsequent `MINTER_ROLE` grant to match `boundMinter`. After deploy, an ERC20 admin (even if rogue) cannot grant `MINTER_ROLE` to themselves. The deploy script calls `bindMinter` so production deployments engage the binding by default.

| | |
|---|---|
| ID | ATS-04 |
| Title | Unenforced coupling between two highest-privilege roles allows backing-invariant break by either holder |
| Severity | **Medium** (centralization with insufficient on-chain enforcement) |
| Likelihood | Low under disciplined operator behaviour; Medium under incident response, partial hand-off, or post-incident multisig changes |
| Impact | High (1:1 backing invariant breaks; unbacked wAJUN can be minted to any address) |
| Status | Open |
| Location | `contracts/AjunaWrapper.sol:30-90`, `contracts/AjunaERC20.sol:25-64`. The contracts have no cross-reference between owner and default-admin. |
| Category | Centralization / Access Control |

**Description.** The wrapper's `owner()` controls `pause`, `rescueToken`, allowlist, and `_authorizeUpgrade`. The ERC20's `defaultAdmin()` controls *who holds `MINTER_ROLE` on the ERC20*. The wrapper's invariant `wAJUN.totalSupply() == AJUN.balanceOf(wrapper)` rests on the assumption that *only the wrapper* holds `MINTER_ROLE`. That assumption holds only if the ERC20 admin chooses to keep it true.

The production checklist Phase 9C names this as an off-chain monitor recommendation:

> Verify `wrapper.owner() == token.defaultAdmin()`. The contracts do not enforce this coupling, but it is the recommended state — divergence enables partial privilege escalation. Set up an off-chain monitor for the inverted condition.

But the contracts make no attempt to enforce the coupling. There are several plausible paths to divergence:
- A typo in the multisig address used for the ERC20 hand-off vs. the wrapper hand-off.
- The wrapper's two-step `Ownable2Step` accept lands in a different block than the ERC20's delayed `acceptDefaultAdminTransfer`. If the multisig's signing strategy changes between those two events (signers rotated, multisig replaced), the two contracts can end up under different multisig instances.
- An incident-response action that rotates one multisig but forgets the other.

**Attack scenario (assuming the divergence is in place).**
1. Wrapper owner: multisig A (intended).
2. ERC20 default admin: rogue address R (e.g. compromised key, or a stale deployer EOA per ATS-01).
3. R calls `token.grantRole(MINTER_ROLE, R)`.
4. R calls `token.mint(R, 1e30)`.
5. wAJUN total supply > AJUN balance of wrapper. R now holds 1e30 unbacked wAJUN, transferable to any DEX/liquidity pool that lists wAJUN.

PoC (`test/audit/spec_mismatch.test.ts:142-205`) executes exactly this and asserts `isInvariantHealthy() == false`.

**Proof.**
```
$ npx hardhat test test/audit/spec_mismatch.test.ts
✔ ERC20 admin (≠ wrapper owner) can mint unbacked wAJUN, breaking the 1:1 invariant
```

**Affected actors.** A9 (`DEFAULT_ADMIN_ROLE` holder) becomes a single point of failure independent from A5.

**Recommendation.** Introduce a *contract-enforced* coupling. Two viable shapes:

1. **Strong enforcement (preferred).** Make `AjunaERC20` honor only `MINTER_ROLE` grants where the grantee equals `wrapper.owner()`'s declared wrapper address (read at grant time from a constant set at init). Rejecting any other `grantRole(MINTER_ROLE, X)` removes the divergence vector entirely.
    - Requires a one-way `setWrapperBinding(address wrapper)` callable once during init.
    - Allowing wrapper upgrades remains fine because the wrapper *address* doesn't change; only its implementation changes.
    - Trade-off: removes the operator's ability to grant `MINTER_ROLE` to a future second wrapper or migration helper. Acceptable given the security gain.

2. **Weaker enforcement.** Require `wrapper.owner() == token.defaultAdmin()` to be true at every state-changing function on either contract via a shared on-chain check. Adds a SLOAD per call but produces a hard guarantee. (Still leaves `MINTER_ROLE` granteable to arbitrary addresses, so doesn't fully close the gap — option 1 is strictly better.)

Either change is in-scope for a V2 upgrade.

If neither is acceptable, at minimum document the dependency more prominently in `docs/SECURITY.md` (currently only in `docs/PRODUCTION-CHECKLIST.md` Phase 9C — easy to miss) and ship an off-chain monitor in-repo (a small TypeScript script that polls both addresses and alerts on divergence).

**References.** Cross-link to ATS-01 (which extends the divergence window).

---

### ATS-05 — Wrapper's `__gap` arithmetic comment is off-by-one (one slot of headroom under-reserved, not over-reserved) — ✅ **FIXED**

> **Status (post-audit)**: ✅ Fixed. `AjunaWrapper.__gap` is now `[47]`, restoring the original 48-slot reservation. Comment updated to describe the actual packing (slot-1 packing of `allowlistEnabled` saved one slot).

| | |
|---|---|
| ID | ATS-05 |
| Title | `AjunaWrapper.__gap` is `[46]` but should be `[47]` if the goal is "preserve original 48-slot reservation minus what was added" |
| Severity | Informational |
| Likelihood | n/a |
| Impact | One slot of forward-compat headroom forfeited; misleading comment for future contributors |
| Status | Open |
| Location | `contracts/AjunaWrapper.sol:291-296` |
| Category | Storage Layout / Documentation |

**Description.** The wrapper's gap comment claims:

```solidity
// Started at 48; consumed 2 slots for `allowlistEnabled` (bool) and
// `allowlisted` (mapping). Remaining: 46.
uint256[46] private __gap;
```

The verified storage layout (`audit/storage-layout.md`, dumped from solc 0.8.30):

| Slot | Offset | Variable |
|------|--------|----------|
| 0 | 0 | `token` |
| 1 | 0 | `foreignAsset` |
| **1** | **20** | **`allowlistEnabled` (packed)** |
| 2 | 0 | `allowlisted` |
| 3..48 | 0 | `__gap[46]` |

Only **one** new slot was actually consumed (`allowlisted` at slot 2). `allowlistEnabled` was packed into the existing slot 1's free upper bytes by the compiler (an `address` is 20 bytes; the next byte is fair game). To preserve the original 48-slot reservation, the gap should be `[47]`, not `[46]`.

This is not a safety issue — the gap is *over*-conservative, not under-reserved. The contract uses one more storage slot of forward-compat budget than necessary.

**Subtler concern (for a hypothetical V1→V2 upgrade).** If a real V1 had been deployed without the allowlist fields and then upgraded in place to the current code, slot 1's upper bytes were always zero in V1's storage. Post-upgrade, `allowlistEnabled` would read as `false` — the *opposite* of the secure default. The current `initialize()` writes `true`, but `initialize()` does not run on an upgrade. `docs/UPGRADE.md` lines 285–309 acknowledge this class of issue and recommend an explicit `reinitializer(N)` migration. For a fresh deploy this concern does not manifest because `initialize()` runs.

**Recommendation.**
- Bump the gap to `[47]`, or
- Update the comment to match reality: "Original `__gap[48]`. Added: 1 mapping slot (`allowlisted`); 1 bool packed into the existing slot 1. Reserved 1 extra slot for defensive headroom — shrink to `[47]` if a future variable demands the slot back."

Either is fine. The point is the comment must agree with the layout.

---

### ATS-06 — Multiple docs and one mock NatSpec contradict the verified storage layout — ✅ **FIXED**

> **Status (post-audit)**: ✅ Fixed. Storage tables in `docs/ARCHITECTURE.md` and `docs/UPGRADE.md` regenerated from the solc storageLayout output (matches `audit/storage-layout.md`). V2 mock NatSpec corrected to note `version` lives at slot 49, after the gap.

| | |
|---|---|
| ID | ATS-06 |
| Title | `docs/ARCHITECTURE.md`, `docs/UPGRADE.md`, and `contracts/mocks/AjunaWrapperV2.sol` describe storage that does not match the deployed layout |
| Severity | Informational |
| Likelihood | n/a (documentation rot) |
| Impact | Future contributors will reason from incorrect storage maps. |
| Status | Open |
| Location | `docs/ARCHITECTURE.md:242`, `docs/UPGRADE.md:268`, `contracts/mocks/AjunaWrapperV2.sol:12` |
| Category | Spec Mismatch / Storage Layout |

**Description.**

| Source | Says | Reality |
|--------|------|---------|
| `docs/ARCHITECTURE.md:236-242` | `AjunaWrapper` slots: `token@0`, `foreignAsset@1`, `__gap[48]@2..49` | `token@0`, `foreignAsset+allowlistEnabled@1`, `allowlisted@2`, `__gap[46]@3..48` |
| `docs/UPGRADE.md:265-275` | Same as above | Same delta |
| `contracts/mocks/AjunaWrapperV2.sol:12` | `version` "occupies one slot from `__gap`" | `version` is at slot 49, *after* `__gap[46]` ends at slot 48 |

Documentation rot post-allowlist work. None of these affect runtime behaviour today, but each will cause confusion the next time a new state variable is added. Fix together with ATS-05.

**Recommendation.** Regenerate the storage tables in both docs from `audit/storage-layout.md` (or from a future `npx hardhat run scripts/dump_storage_layout.ts` script — recommended addition). Correct the V2 mock NatSpec.

---

### ATS-07 — `scripts/deploy_mock_foreign_asset.ts` calls `AjunaERC20.initialize` with the wrong signature — ✅ **FIXED**

> **Status (post-audit)**: ✅ Fixed. The mock-deploy script now passes the 5th `initialAdminDelay` argument (`0`).

| | |
|---|---|
| ID | ATS-07 |
| Title | Local-dev mock-deploy script omits the `initialAdminDelay` parameter |
| Severity | Low |
| Likelihood | High *for any operator running the local-dev flow* |
| Impact | Local-dev script is broken; production unaffected. |
| Status | Open |
| Location | `scripts/deploy_mock_foreign_asset.ts:33-38` |
| Category | Spec Mismatch / Deployment |

**Description.** The script encodes `initialize(name, symbol, admin, decimals)` — four arguments — but the current `AjunaERC20.initialize` takes five (the last is `uint48 initialAdminDelay`, added with `AccessControlDefaultAdminRulesUpgradeable`). The proxy deployment will revert.

```ts
const initData = AjunaERC20.interface.encodeFunctionData("initialize", [
  "Mock AJUN Foreign Asset",
  "AJUN",
  deployer.address, // admin
  12                // decimals — must match production AJUN
]);
// ↑ missing the 5th argument (initialAdminDelay)
```

This script is local-dev only. Production deployment uses `scripts/deploy_wrapper.ts`, which is correct.

**Recommendation.**

```diff
 const initData = AjunaERC20.interface.encodeFunctionData("initialize", [
   "Mock AJUN Foreign Asset",
   "AJUN",
   deployer.address,
-  12
+  12,
+  0,            // initialAdminDelay — instant for the local mock
 ]);
```

---

### ATS-08 — Foreign-asset / wAJUN decimals coherence is not enforced — ✅ **FIXED**

> **Status (post-audit)**: ✅ Fixed. `IERC20Precompile` now declares `decimals()`. `AjunaWrapper.initialize` requires `foreignAsset.decimals() == token.decimals()`. New test in `wrapper.test.ts` proves a mismatched-decimals wrapper init reverts. Test mocks (`BadERC20`, `FeeOnTransferERC20`, `ReentrantToken`, `InvariantSnoopToken`, `HalfBadERC20`) all override `decimals()` to return 12 to match the test wAJUN.

| | |
|---|---|
| ID | ATS-08 |
| Title | `AjunaERC20._tokenDecimals` is set in init to a parameter; nothing checks it equals `foreignAsset.decimals()` |
| Severity | Informational |
| Likelihood | Low (operator hardcodes `12` everywhere; AJUN is fixed) |
| Impact | Internal accounting unaffected (raw units are 1:1); UIs would mis-display amounts |
| Status | Open |
| Location | `contracts/AjunaERC20.sol:51-64` (`require(decimals_ <= 18)` only); `contracts/AjunaWrapper.sol:74-90` (no decimals check) |
| Category | Initialization / Accounting |

**Description.** The wrapper operates entirely in smallest units, so a decimals mismatch between wAJUN and the underlying AJUN precompile would not affect the 1:1 invariant. But UIs that compute `amount * 10**decimals` would display incorrect human-readable amounts on one side, which is a real user-confusion risk when the foreign asset is later changed via UUPS upgrade.

The init guard is only `decimals_ <= 18`. Production AJUN has decimals 12, the deploy script hardcodes 12, and `IERC20Precompile` does not expose `decimals()` so the wrapper cannot read it. (The interface should — see *Recommendation*.)

**Recommendation.** Add `decimals()` to `IERC20Precompile.sol` and assert in `AjunaWrapper.initialize`:

```solidity
require(
  IERC20MetadataLike(_foreignAssetPrecompile).decimals() == token.decimals(),
  "AjunaWrapper: decimals mismatch"
);
```

Cheap belt-and-braces; would have caught a misconfiguration in CI even if the deploy script were copy-pasted with a different `DECIMALS` env var.

---

### ATS-09 — `AjunaWrapper` inherits non-upgradeable `ReentrancyGuard`; OZ upgrades-core fails validation — ✅ **FIXED**

> **Status (post-audit)**: ✅ Fixed. The audit's recommended import (`ReentrancyGuardUpgradeable`) does not exist in OZ 5.6.1 (removed during the OZ 5.4 → 5.6.1 migration; the standalone `ReentrancyGuard` was reframed as `@custom:stateless`). Instead: removed the `ReentrancyGuard` parent entirely and inlined `nonReentrant` / `nonReentrantView` modifiers in `AjunaWrapper.sol` using the same namespaced ERC-7201 slot (`openzeppelin.storage.ReentrancyGuard`). `initialize()` explicitly writes `NOT_ENTERED == 1` to the proxy slot, so the safety story is "explicitly initialized on first use" rather than "0 != ENTERED by accident". Verified: `npx --yes @openzeppelin/upgrades-core validate artifacts/build-info` now returns `SUCCESS (4 upgradeable contracts detected, 4 passed, 0 failed)`. The `audit/storage_probe.test.ts` PoC was updated to assert the proxy slot is now 1 (was 0 pre-fix).

| | |
|---|---|
| ID | ATS-09 |
| Title | Inheriting `@openzeppelin/contracts/utils/ReentrancyGuard` (constructor) breaks the upgrades-plugin contract; behaviour is safe today by accident |
| Severity | Low (today) / would become Medium under an OZ v6 dependency bump |
| Likelihood | Low (no current attack); High that the dependency will bump |
| Impact | Latent: behaviour change on dependency upgrade; tooling refusal today |
| Status | Open |
| Location | `contracts/AjunaWrapper.sol:5,30` |
| Category | Upgradeability / Compiler-Toolchain |

**Description.** The wrapper imports the *non-upgradeable* `ReentrancyGuard`:

```solidity
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
...
contract AjunaWrapper is Initializable, Ownable2StepUpgradeable, ReentrancyGuard, PausableUpgradeable, UUPSUpgradeable { ... }
```

Three concerns layer on this choice:

1. **OZ upgrades-core refuses to validate.**

   ```
   ✘ contracts/AjunaWrapper.sol:AjunaWrapper
       @openzeppelin/contracts/utils/ReentrancyGuard.sol:58: Contract `ReentrancyGuard` has a constructor
           Define an initializer instead
           https://zpl.in/upgrades/error-001
   ```
   `hardhat-upgrades`' standard `deployProxy` / `upgradeProxy` flow would reject the wrapper without an explicit `@custom:oz-upgrades-unsafe-allow` annotation. The project sidesteps this by deploying via raw `ERC1967Proxy`, but operators using the standard plugin (or future automation) will be blocked.

2. **Constructor only ran on the implementation, not the proxy.** The `ReentrancyGuard` constructor sets `_status = NOT_ENTERED == 1` at the namespaced slot `0x9b779b…`. That write hits the implementation's storage at deployment time. The proxy's storage at the same namespaced slot is never written by `initialize()`. Verified via direct `provider.getStorage(proxy, REENTRANCY_GUARD_SLOT)` in `test/audit/storage_probe.test.ts`:

   ```
   implementation _status = 0x01  (NOT_ENTERED — set by constructor)
   proxy          _status = 0x00  (never written)
   ```

   The behaviour is *currently* safe because `_nonReentrantBefore` checks `value == ENTERED == 2`, so `0 != 2` does not revert. After the first call, `_nonReentrantAfter` writes `value = 1`, and from then on the slot is properly initialised. So there is no correctness issue *today* — the guard works.

3. **Future fragility.** OZ v5.5 marked `ReentrancyGuard` as "Deprecated. … will be removed and replaced by `ReentrancyGuardTransient` in v6.0." A bump to v6 would silently change the storage backend from a namespaced storage slot to *transient storage* (TSTORE/TLOAD, EIP-1153). On EVM mainnet post-Cancun this is a transparent gas optimisation. On PVM (`pallet-revive`), EIP-1153 support is **not** specified by the contract assumption — if `tstore` is unimplemented or partially implemented, the guard could silently degrade. No sentinel in code would detect the regression.

**Recommendation.** Switch the import to the upgradeable equivalent and call its initializer:

```diff
- import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
+ import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
...
- contract AjunaWrapper is Initializable, Ownable2StepUpgradeable, ReentrancyGuard, PausableUpgradeable, UUPSUpgradeable {
+ contract AjunaWrapper is Initializable, Ownable2StepUpgradeable, ReentrancyGuardUpgradeable, PausableUpgradeable, UUPSUpgradeable {
...
function initialize(address _token, address _foreignAssetPrecompile) public initializer {
    ...
    __Ownable_init(msg.sender);
    __Ownable2Step_init();
    __Pausable_init();
+   __ReentrancyGuard_init();
    ...
}
```

`ReentrancyGuardUpgradeable` uses the same namespace string (`openzeppelin.storage.ReentrancyGuard`) and the same slot constant, so the storage location is unchanged. The init function sets the proxy's slot to `NOT_ENTERED`, removing the "by accident" qualifier from the safety story and removing the OZ upgrades-core failure. Pin the OZ version explicitly in `package.json` so a future v6 bump is a deliberate decision.

**Cross-reference.** Trust assumption T6.

---

### ATS-10 — `_authorizeUpgrade`'s `code.length > 0` check is EVM-Cancun-correct but PVM-unspecified — ✅ **DOCUMENTED**

> **Status (post-audit)**: ✅ Documented. New entry in `docs/SECURITY.md` Known Risks table flags PVM `SELFDESTRUCT` semantics as a runtime trust assumption to verify against the deployed `pallet-revive` version. No code change (option 1 from the recommendation; option 2 — defensive `extcodehash` re-check — was assessed as too heavy for a niche risk).

| | |
|---|---|
| ID | ATS-10 |
| Title | Code-presence check is a one-shot snapshot; PVM-specific code-clearing semantics are not specified |
| Severity | Informational |
| Likelihood | Low |
| Impact | Could brick the proxy if PVM allows post-deployment code clearing |
| Status | Open |
| Location | `contracts/AjunaWrapper.sol:287-289`, `contracts/AjunaERC20.sol:97-99` |
| Category | Compiler/Toolchain / Upgradeability |

**Description.** Both `_authorizeUpgrade` overrides include:

```solidity
require(newImplementation.code.length > 0, "AjunaWrapper: implementation not a contract");
```

This rejects EOA targets at upgrade time — good. But the check is a **snapshot** taken when the upgrade transaction lands. After the upgrade, if the new implementation is later self-destructed, the proxy's `delegatecall` will hit empty code and the contract is bricked.

On EVM mainnet post-Cancun (EIP-6780), `SELFDESTRUCT` is a no-op for any non-creation-tx contract, so this concern is gone for the standard EVM target. On PVM (`pallet-revive`), the equivalent semantics are not specified by the project's assumptions and there is no cross-reference to the runtime.

The contract should not assume anything about PVM-specific opcode behaviour without stating it as an explicit trust assumption.

**Recommendation.** Either:
1. Document this as an explicit trust assumption in `docs/SECURITY.md` ("The PVM runtime does not allow a deployed contract's code to be cleared post-deployment, equivalent to EIP-6780 on Cancun-and-later EVM"), and verify against the `pallet-revive` spec.
2. Defensively, store the new implementation's `extcodehash` in `_authorizeUpgrade` and have the proxy delegate-call layer (or an off-chain monitor) periodically re-check it against the current `extcodehash`. This is heavy machinery for a niche risk; option 1 is the realistic answer.

---

### ATS-11 — Read-only reentrancy on `isInvariantHealthy()` — ✅ **FIXED**

> **Status (post-audit)**: ✅ Fixed. `isInvariantHealthy()` and the new sister views (`getInvariantDelta`, `isUnderCollateralized` per ATS-12) all carry the inline `nonReentrantView` modifier. The PoC test (`audit/readonly_reentrancy.test.ts`) was updated: the snoop foreign asset's `try/catch` around `isInvariantHealthy()` now catches a revert (rather than capturing a transient false), proving the read-only-reentrancy surface is closed.

| | |
|---|---|
| ID | ATS-11 |
| Title | Mid-deposit observation of `isInvariantHealthy()` returns `false` even when the deposit will succeed |
| Severity | Informational |
| Likelihood | Low (requires a malicious or future fee-on-transfer foreign asset) |
| Impact | Low (no funds at risk; misleads off-chain consumers) |
| Status | Open |
| Location | `contracts/AjunaWrapper.sol:228-230` (view) and `contracts/AjunaWrapper.sol:162-185` (deposit) |
| Category | Reentrancy / View Function |

**Description.** During `deposit`, between `safeTransferFrom` and `mint`, the wrapper holds `balanceBefore + amount` AJUN but `totalSupply()` is still at its pre-deposit value. `isInvariantHealthy()` is a `view` function, so it cannot acquire the reentrancy mutex; any external integrator (or a contract called *by* the foreign asset) reading the view in this window observes `false` (over-collateralized transient state) — even though the surrounding tx will succeed and leave the invariant healthy.

The trusted AJUN precompile has no callback semantics, so this can only manifest if the foreign asset is malicious. If a future runtime upgrade introduces fee-on-transfer or delivery hooks on the precompile, `isInvariantHealthy()` becomes unreliable for *any* on-chain consumer that reads it from inside a deposit-touched code path.

**Proof.** `test/audit/readonly_reentrancy.test.ts` constructs a foreign-asset mock that snoops the view from inside `transferFrom` and asserts the captured value is `false` even though the deposit succeeds:

```
✔ isInvariantHealthy() returns false mid-deposit even though the deposit will succeed
```

**Affected actors.** A14 (malicious foreign asset), and any on-chain integrator reading `isInvariantHealthy()` in the same atomic context as a deposit they triggered.

**Recommendation.** Either:
1. Add `nonReentrantView` (OZ v5.5+ provides this) to `isInvariantHealthy()` so the function reverts when called inside a `nonReentrant` execution. Note: `nonReentrantView` reverts mid-tx rather than returning stale data; consumers must handle the revert gracefully. Recommended for clarity.
2. Document the read-only reentrancy risk in `docs/SECURITY.md` and instruct integrators to never gate decisions on a single mid-tx read.

If option 1 is taken, also confirm that `nonReentrantView` works correctly under the proxy storage starting at 0 (per ATS-09); the `_reentrancyGuardEntered()` check returns `value == ENTERED`, so 0 != 2 → false → no revert outside an active call. This is the same behaviour pattern, just verified on the read path.

---

### ATS-12 — `isInvariantHealthy()` conflates over- and under-collateralization in its boolean return — ✅ **FIXED**

> **Status (post-audit)**: ✅ Fixed. Added two sister views: `getInvariantDelta() returns (int256)` (positive = under-backed, urgent alarm; zero = exact; negative = over-collateralized) and `isUnderCollateralized() returns (bool)` (the predicate monitors should alarm on). Existing `isInvariantHealthy()` retained for backward compatibility. New tests cover all three views.

| | |
|---|---|
| ID | ATS-12 |
| Title | Single-bit health view loses sign information; off-chain consumers can be misled |
| Severity | Informational |
| Likelihood | n/a |
| Impact | Operational alarm fidelity |
| Status | Open |
| Location | `contracts/AjunaWrapper.sol:215-230` |
| Category | Spec / API Design |

**Description.** The function returns `totalSupply == balanceOf(wrapper)`. False can mean either:
- `totalSupply > balanceOf` — system is **under-collateralised**, the failure mode that puts users at risk; or
- `totalSupply < balanceOf` — system is **over-collateralised** (e.g., someone direct-transferred AJUN to the wrapper without depositing), which is harmless.

The NatSpec at lines 215–227 acknowledges this and instructs monitors to "treat `totalSupply > balanceOf` as the urgent alarm." But the function itself returns one bit, so a generic monitor wired to `isInvariantHealthy() == true` will alarm equally on both cases. This is a real operational concern; a noisy alarm gets ignored.

**Recommendation.** Add a sister view that surfaces the sign:

```solidity
/// @notice Returns the signed delta `totalSupply - balanceOf(wrapper)`.
///         Positive => under-backed (alarm); zero => exact; negative => over-collateralized (safe).
function getInvariantDelta() external view returns (int256) {
    return int256(token.totalSupply()) - int256(foreignAsset.balanceOf(address(this)));
}

/// @notice Returns true iff totalSupply > balanceOf(wrapper) — the only state that puts users at risk.
function isUnderCollateralized() external view returns (bool) {
    return token.totalSupply() > foreignAsset.balanceOf(address(this));
}
```

Existing `isInvariantHealthy()` can stay for backward-compatibility.

---

### ATS-13 — `pause` does not block `upgradeToAndCall`, `rescueToken`, allowlist toggles, or ownership transfer

| | |
|---|---|
| ID | ATS-13 |
| Title | Pause is a user-funds circuit breaker, not an admin lock |
| Severity | Informational |
| Likelihood | n/a |
| Impact | Documented design; surfaced for completeness |
| Status | Open |
| Location | `contracts/AjunaWrapper.sol:162,194` (only `whenNotPaused`-guarded paths) |
| Category | Spec / Operational |

**Description.** `whenNotPaused` is only on `deposit` and `withdraw`. `rescueToken`, `setAllowlistEnabled`, `setAllowlist`, `setAllowlistBatch`, `transferOwnership`, and `upgradeToAndCall` remain callable while paused. This is by design — pausing must not lock out emergency response. `docs/SECURITY.md:236-244` documents this clearly.

The follow-on observation: a key compromise that grabs the owner can `upgradeToAndCall` to a malicious implementation *while the contract is paused by the same owner*. Pausing does not bound upgrade-key risk. The known-risks table in `docs/SECURITY.md` lists "Owner key compromise — Critical" so this is acknowledged.

**Recommendation.** None at the contract level. Operational mitigation: deploy a timelock in front of the multisig (already a recommended action in `docs/SECURITY.md` Production Hardening Checklist; track until done). The timelock should gate `upgradeToAndCall` with a delay that allows an emergency veto window between proposal and execution.

---

### ATS-14 — `rescueToken` does not reject `to == address(this)` — ✅ **FIXED**

> **Status (post-audit)**: ✅ Fixed. `rescueToken` now requires `to != address(this)`. New test verifies the revert.

| | |
|---|---|
| ID | ATS-14 |
| Title | Self-rescue is a no-op but still permitted |
| Severity | Gas / Informational |
| Likelihood | Low |
| Impact | None — wastes gas |
| Status | Open |
| Location | `contracts/AjunaWrapper.sol:257-263` |
| Category | Code Quality |

**Description.** `rescueToken(token, address(this), amount)` is allowed by the current checks (`tokenAddress != foreignAsset && tokenAddress != token && to != address(0)`). It would `safeTransfer` the contract's tokens to itself — a no-op that emits a misleading `TokenRescued` event.

**Recommendation.**

```diff
 require(to != address(0), "AjunaWrapper: rescue to zero address");
+require(to != address(this), "AjunaWrapper: rescue to self");
```

Trivial; only worth doing because `TokenRescued` event consumers shouldn't see no-op events.

---

### ATS-15 — `onlyAllowedUser` modifier reads `owner()` on every gated call (gas)

| | |
|---|---|
| ID | ATS-15 |
| Title | Allowlist gate does an unconditional `owner()` SLOAD even when `allowlistEnabled == false` |
| Severity | Gas |
| Likelihood | n/a |
| Impact | Negligible — well within block-gas budget on PVM |
| Status | Open |
| Location | `contracts/AjunaWrapper.sol:111-116` |
| Category | Gas |

**Description.** Once the allowlist is disabled (post-Phase-11), `allowlistEnabled` reads `false` and the modifier short-circuits before `owner()` is read — actually, let me re-read:

```solidity
modifier onlyAllowedUser() {
    if (allowlistEnabled && msg.sender != owner()) {
        require(allowlisted[msg.sender], "AjunaWrapper: not allowlisted");
    }
    _;
}
```

Solidity's `&&` short-circuits, so when `allowlistEnabled == false` the `owner()` SLOAD is skipped. **No issue**. Filing this finding "Gas" only to record the cross-check; on re-reading the code does the optimal thing.

**Recommendation.** None.

---

## 5. Invariant & property analysis

Each property below was checked by code reading and, where feasible, by a test. *Held* / *Held-with-caveats* / *Violated* / *Indeterminate* per the brief.

### 5.1 Backing & accounting

| # | Property | Status | Evidence / Caveat |
|---|----------|--------|-------------------|
| B1 | `wAJUN.totalSupply()` increases iff `AJUN.balanceOf(wrapper)` increases by the same amount, and conversely on burn. | **Held-with-caveats** | Test: `wrapper.test.ts:checkInvariant` after every state change; passes 91/91. **Caveats:** ATS-04 (ERC20 admin can grant `MINTER_ROLE` and bypass), ATS-01 (window during which deployer EOA still holds `DEFAULT_ADMIN_ROLE`). |
| B2 | No path mints wAJUN without a prior matching transfer of AJUN into the wrapper. | **Held in core code** | Verified: `mint` is `onlyRole(MINTER_ROLE)`; only the wrapper holds the role per deploy script. Same caveat as B1. |
| B3 | No path releases AJUN without a prior matching burn of wAJUN. | **Held** | `withdraw` does `burnFrom` then `safeTransfer`; `safeTransfer` revert rolls back the burn. `rescueToken` rejects `foreignAsset` address. |
| B4 | Direct ERC20 transfers of AJUN to the wrapper cannot be withdrawn by users (over-collateralization is permanently locked). | **Held** | Verified via `wrapper.test.ts:1216` — direct transfer makes `isInvariantHealthy()` return `false` (over-collateralized side); no user path can extract the surplus. **Documented intent.** |
| B5 | `AjunaERC20._tokenDecimals` matches the foreign asset's decimals. | **Indeterminate** | Not enforced (ATS-08). Set by deploy parameter; no on-chain check. |
| B6 | The fee-on-transfer balance-delta defence in `deposit` mints exactly what the wrapper received. | **Held** | LOW-1 fix verified by `wrapper.test.ts:Fee-on-transfer Defense`. |

### 5.2 Access control

| # | Property | Status | Evidence / Caveat |
|---|----------|--------|-------------------|
| C1 | Only the wrapper holds `MINTER_ROLE` post-deploy hand-off. | **Indeterminate** | Depends on operator following `docs/PRODUCTION-CHECKLIST.md` Phase 5 verification *and* keeping `DEFAULT_ADMIN_ROLE` aligned with `wrapper.owner()` (ATS-04). |
| C2 | `DEFAULT_ADMIN_ROLE` rotation cannot be bricked. | **Held** | Two-step + delay; cancellable; exactly-one-admin invariant. Tests at `wrapper.test.ts:1308-1369`. |
| C3 | `Ownable2Step`: pending owner cannot act, accept must be from new owner, renounce is disabled. | **Held** | Tested at `wrapper.test.ts:619-686`. |
| C4 | `onlyAllowedUser` cannot be bypassed (no `tx.origin`, meta-tx, EIP-1271, hooks, fallback). | **Held** | Modifier reads `msg.sender`, which is the immediate caller; no `tx.origin`; the wrapper exposes no fallback / receive function (verified by source). |

### 5.3 Reentrancy & external calls

| # | Property | Status | Evidence / Caveat |
|---|----------|--------|-------------------|
| R1 | All state-changing user functions are `nonReentrant`. | **Held** | `deposit` and `withdraw` carry `nonReentrant`. `rescueToken` is owner-only and not user-callable. |
| R2 | `_status` is correctly initialized in proxy storage. | **Held-with-caveats** | The proxy storage at the namespaced slot starts at `0`, NOT `1 (NOT_ENTERED)`. Behaviour is safe because `0 != 2 (ENTERED)`. ATS-09 — recommend switching to `ReentrancyGuardUpgradeable` so the proxy storage is initialised. |
| R3 | A future OZ version bump that changes ReentrancyGuard storage layout would not silently corrupt state. | **Indeterminate** | `_status` lives at a fixed namespaced slot, so the slot itself wouldn't move. But OZ v6's planned switch to transient storage changes the storage *kind*; PVM EIP-1153 support is the open question. ATS-09. |
| R4 | Cross-function reentrancy across `deposit`/`withdraw`/`rescueToken`. | **Held** | Same `_status` mutex covers both deposit and withdraw. `rescueToken` is owner-only and lacks `nonReentrant`, but the only external call is `IERC20(tokenAddress).safeTransfer`; if `tokenAddress` is malicious and re-enters `pause` or `rescueToken` again, no state path leads to fund loss. |
| R5 | Read-only reentrancy on `isInvariantHealthy()`. | **Violated (informational)** | PoC at `test/audit/readonly_reentrancy.test.ts`. ATS-11. |

### 5.4 Upgrade safety

| # | Property | Status | Evidence / Caveat |
|---|----------|--------|-------------------|
| U1 | `_authorizeUpgrade` is access-controlled. | **Held** | `onlyOwner` (wrapper) / `onlyRole(UPGRADER_ROLE)` (ERC20). |
| U2 | `code.length > 0` check prevents EOA upgrades. | **Held at upgrade time** | Tests at `wrapper.test.ts:513-525`. Not a guarantee for the lifetime of the proxy on PVM (ATS-10). |
| U3 | Storage gap arithmetic is correct in `AjunaWrapper`. | **Held-with-caveats** | Slot allocation is collision-free. Comment is off-by-one (ATS-05). |
| U4 | Storage gap arithmetic is correct in `AjunaERC20`. | **Held** | `_tokenDecimals@0`, `__gap[49]@1..49`. |
| U5 | Re-initialization protected on both contracts and on the implementations directly. | **Held** | `_disableInitializers()` in implementation constructors; `initializer` modifier on both `initialize` functions. Tests at `wrapper.test.ts:418-428,502-511`. |
| U6 | V1 → V2 upgrade preserves storage. | **Held** | Tests at `wrapper.test.ts:527-612`. **Caveats:** V2 mocks have unauthenticated `migrateToV2` (ATS-03). |
| U7 | OZ upgrades-core validate succeeds. | **Violated** | Fails on `AjunaWrapper`/`AjunaWrapperV2` due to non-upgradeable `ReentrancyGuard` constructor (ATS-09). |
| U8 | Owner cannot brick own upgrade ability via ownership transfer. | **Held-with-caveats** | Two-step `Ownable2Step` requires the new owner to call `acceptOwnership()`, proving they can sign txs. They could later be a contract that signs `acceptOwnership` but cannot encode `upgradeToAndCall` correctly — but that is an own-foot-shooting risk, not a bug. |

### 5.5 Pause, allowlist, rescue

| # | Property | Status | Evidence / Caveat |
|---|----------|--------|-------------------|
| P1 | Pause blocks `deposit` and `withdraw`. | **Held** | Tests at `wrapper.test.ts:296-329`. |
| P2 | Pause does NOT block `rescueToken`, allowlist edits, ownership transfer, or upgrade. | **Held (by design)** | ATS-13 informational. |
| P3 | Allowlist behaves consistently when toggled mid-block. | **Held** | The mapping/flag are simple SLOADs; no race window beyond standard EVM ordering. |
| P4 | `setAllowlistBatch` cap (`MAX_ALLOWLIST_BATCH = 100`) prevents owner self-DoS via gas blow-up. | **Held** | Tests at `wrapper.test.ts:1274-1297`. |
| P5 | `rescueToken` cannot drain `foreignAsset` or `token`. | **Held** | Address comparison checks both; the foreign asset address is immutable post-init (only changeable via UUPS upgrade). |

### 5.6 Token / precompile interactions

| # | Property | Status | Evidence / Caveat |
|---|----------|--------|-------------------|
| T1 | SafeERC20 on both legs catches non-standard token returns. | **Held** | Tests at `wrapper.test.ts:1129-1186`. |
| T2 | Behaviour if the precompile reverts: deposit/withdraw revert atomically; no partial state. | **Held** | Solidity revert + atomicity. |
| T3 | Behaviour if the precompile charges a fee: the wrapper mints only `received = balanceAfter - balanceBefore`. | **Held** | LOW-1 verified by `wrapper.test.ts:1236-1268`. |
| T4 | `foreignAsset` cannot be changed except via UUPS upgrade. | **Held** | No setter; only the upgrade path can change it (and the upgrade itself is access-controlled). |
| T5 | Reentrancy via the precompile is blocked by `nonReentrant`. | **Held** | Tests at `wrapper.test.ts:859-895`. Caveat: the test uses an EVM ERC20 mock; PVM precompile semantics are assumed equivalent (T2 in threat model). |

### 5.7 PVM specifics — flagged as assumptions

| # | Property | Status | Evidence / Caveat |
|---|----------|--------|-------------------|
| V1 | `address.code.length` semantics on PVM match EVM. | **Indeterminate** | ATS-10. |
| V2 | `SELFDESTRUCT` (or PVM equivalent) cannot clear deployed code. | **Indeterminate** | ATS-10. |
| V3 | `block.*` semantics match EVM (relevant for `Pausable` events and the ERC20's transfer hooks). | **Held by inspection** | The wrapper does not read `block.*` directly; ERC20 base does not either in the paths used. |
| V4 | Existential-deposit reaping cannot drop the wrapper's locked AJUN. | **Held if Phase 6 of checklist is followed** | Operational — no on-chain enforcement. |
| V5 | EIP-1153 transient storage availability (relevant for ATS-09 mitigation if OZ v6 is adopted). | **Indeterminate** | Cross-reference required to PVM spec. |

---

## 6. Test-suite assessment

The existing suite (91 tests, all passing) covers the core paths thoroughly. Gaps that surfaced during the audit:

### 6.1 What's missing

| Gap | Why it matters | Suggested test |
|-----|----------------|----------------|
| Property-based fuzzing of the 1:1 invariant under random sequences of deposit/withdraw/rescue/allowlist toggles. | The current invariant check runs after each scripted op; a random walk can hit interleavings the scripted tests don't. | `test/audit/fuzz/invariant_deposit_withdraw.t.sol` (Foundry invariant test). 50–100 deposit/withdraw/transfer rounds with arbitrary actors; assert `wrapper.isInvariantHealthy()` after each. |
| Negative test for the `wrapper.owner() == erc20.defaultAdmin()` divergence (ATS-04). | Currently no test alarms on divergence; ATS-04 PoC included as part of this audit. | Already added: `test/audit/spec_mismatch.test.ts` "ERC20 admin (≠ wrapper owner) can mint unbacked wAJUN". Promote to baseline. |
| Test that `scripts/deploy_production.sh`'s post-deploy guidance reverts on the actual contracts. | Catches the spec mismatch at CI time. | Already added: `test/audit/spec_mismatch.test.ts` ATS-02 sub-tests. Promote. |
| Read-only reentrancy snoop on `isInvariantHealthy`. | Currently no test verifies the view's behaviour mid-deposit. | Already added: `test/audit/readonly_reentrancy.test.ts`. |
| Upgrade-from-V1-to-V2 *that does not deploy a fresh proxy*. | Demonstrates the "upgrade-time defaults" issue documented in `docs/UPGRADE.md:285-309` for a new boolean state variable. | Deploy a stripped-V1 proxy (without the allowlist fields), upgrade in place to current code, assert `allowlistEnabled() == false` (the unsafe default), then assert that a `reinitializer(2) migrateToV2()` is required to set it to `true`. |
| Storage probe on the `Pausable._paused` namespaced slot. | Same class of "constructor only ran on impl" check, even though `PausableUpgradeable` is the upgradeable variant and so does have an init function. Belt-and-braces. | Trivial — read `provider.getStorage(proxy, PAUSABLE_SLOT)` and assert. |
| Test that `MINTER_ROLE` cannot be re-granted to a non-wrapper address without the multisig deliberately doing so. | Tightens C1. | The current "Role Management" group already covers re-grant; add an assertion that grant-to-non-wrapper produces a high-priority `RoleGranted(MINTER_ROLE, X)` event that off-chain monitors can pick up. (Documentation, not a contract change.) |
| Test that the `code.length > 0` check fails *after* the implementation is destroyed (where supported). | Currently rejected only at upgrade time. PVM-specific concern. | Skipped for EVM Cancun; mark as PVM-specific TODO. |
| Test that `setAllowlistBatch` reverts cleanly on duplicate addresses (no special handling required, but interesting for ergonomics). | Documentation only. | Optional. |

### 6.2 False negatives

The single false negative I noticed: the test `should preserve storage gap integrity after V2 upgrade` (`wrapper.test.ts:588-612`) is well-named but only verifies *state preservation*, not actual gap math. It would still pass if the V2's `version` were placed in a colliding slot. Replace with a direct slot-by-slot dump assertion (or use the OZ upgrades plugin's storage layout diff).

### 6.3 What's already great

- Every state-changing test calls `checkInvariant()` after the operation. This is the single most effective defence-in-depth in the suite.
- The fee-on-transfer mock (`FeeOnTransferERC20`) and the BadERC20 mock are excellent — they directly exercise the LOW-1 / LOW-A fixes against representative real-world misbehaviour.
- The Allowlist suite covers the lock-out-protection and post-handoff scenarios densely. The MED-1 fix (withdraw is permissionless even with the gate up) has a dedicated test that explicitly names the finding.

---

## 7. Recommendations (prioritized)

### Before disabling the allowlist (Phase 11)

1. **Fix `scripts/deploy_production.sh` (ATS-01).** Replace the broken role-transfer guidance with the correct two-step + delayed flow. Better still, have the script run the right transactions itself.
2. **Enforce or monitor the `wrapper.owner() == erc20.defaultAdmin()` coupling (ATS-04).** Either:
   - On-chain: bind `MINTER_ROLE` grants to the wrapper address only (one-line change in the ERC20), or
   - In-repo: ship an off-chain monitor and add a CI smoke test that verifies the binding immediately post-deploy.
3. **Authenticate V2 mock migrations (ATS-03).** Add `onlyOwner` / `onlyRole(UPGRADER_ROLE)` to `migrateToV2` in both V2 mocks. Prevent the bad pattern from being copy-pasted.
4. **Switch to `ReentrancyGuardUpgradeable` (ATS-09).** One-line import change + an `__ReentrancyGuard_init()` call in `initialize`. Removes the OZ upgrades-core failure and the "safe by accident" qualifier.

### Before next version bump

5. **Pin OZ versions explicitly in `package.json`** so a future v6 upgrade is a deliberate decision (avoids ATS-09 transient-storage swap).
6. **Realign documentation with code (ATS-02, ATS-06).** Update `docs/UPGRADE.md` "Making a Contract Non-Upgradeable" and the storage-layout tables in `docs/ARCHITECTURE.md` and `docs/UPGRADE.md`. Update the V2 mock NatSpec.
7. **Add `decimals()` enforcement (ATS-08).** Extend `IERC20Precompile` with `decimals()` and assert equality in `initialize`.

### Hardening

8. **Add `nonReentrantView` to `isInvariantHealthy` and rename per ATS-12.** Pair-changed: introduce `getInvariantDelta()` and `isUnderCollateralized()` views.
9. **Document PVM trust assumptions explicitly (ATS-10).** Cite the `pallet-revive` spec or reproduce the relevant section in `docs/SECURITY.md`.
10. **Add property-based fuzz coverage** for the 1:1 invariant (Foundry's `invariant_*` testing or Echidna). Cheap, high-value.
11. **Stand up a timelock in front of the multisig** before opening the gate (already in `docs/SECURITY.md` Production Hardening Checklist; track until done).

### Cosmetic

12. ATS-05 — bump gap to `[47]` *or* update the comment to match reality.
13. ATS-07 — fix the local-dev mock-deploy script's missing `initialAdminDelay`.
14. ATS-14 — add `to != address(this)` check to `rescueToken`.

---

## 8. Appendix

### 8.1 Threat model

See [audit/threat-model.md](threat-model.md). Actor matrix A1–A14, trust assumptions T1–T8.

### 8.2 Storage layout

See [audit/storage-layout.md](storage-layout.md). Verified slot maps for both production contracts and the V2 mocks; runtime confirmation of the namespaced ReentrancyGuard slot starting at 0 on the proxy.

### 8.3 Tooling log

See [audit/tools.log](tools.log). Exact commands, versions, raw outputs.

### 8.4 Checklists used

- **OWASP Smart Contract Top 10** — covered via manual review.
- **SWC registry** — relevant entries cross-referenced inline (SWC-107 reentrancy, SWC-114 transaction-order dependency, SWC-128 DoS via gas, SWC-115 `tx.origin` (n/a), SWC-118 incorrect constructor (n/a — `_disableInitializers()`), SWC-127 arbitrary jump (n/a)).
- **OpenZeppelin "Common Mistakes" upgrade-safety guide** — cross-referenced; produced ATS-09.
- **Trail of Bits "Slither" detector list** — full sweep, no high-impact production findings.

### 8.5 Residual risks (post-recommendations)

- **Multisig key compromise** — outside contract scope. Mitigated by hardware-wallet hygiene and multisig threshold; recommended timelock would add a veto window.
- **PVM runtime semantic divergence from EVM** — requires PVM-spec cross-reference; no on-chain mitigation possible.
- **Foreign-asset precompile semantic change** — out of scope for the contract; the LOW-1 balance-delta defence already mitigates fee-on-transfer; rebasing remains a hard problem (would require an explicit `_authorizeUpgrade`-driven runbook to redeploy the wrapper with corrective accounting).
- **Off-chain monitor failure** — the only authoritative liveness signal for ATS-04 today is an off-chain monitor. Without on-chain enforcement, monitor downtime extends the unenforced-coupling window.

### 8.6 Deployment-checklist deltas vs. `docs/PRODUCTION-CHECKLIST.md`

| Add / Modify | Where | Why |
|--------------|-------|-----|
| Phase 4 — explicitly forbid using `scripts/deploy_production.sh`'s post-deploy printout in isolation. | Phase 4. | Reduces ATS-01 likelihood. |
| Phase 7 — assert `token.hasRole(MINTER_ROLE, wrapper) == true && token.hasRole(MINTER_ROLE, anyOther) == false` *before* funding the wrapper. | Phase 5/7 boundary. | Catches a partial deploy where MINTER_ROLE was granted to two addresses. |
| Phase 9C — add the *contract change* (or off-chain monitor) for ATS-04. | Phase 9C. | Currently a recommendation; promote to mandatory until ATS-04 is fixed on-chain. |
| Phase 11 — block-list "do not disable allowlist" until ATS-01/03/04/09 are closed. | Phase 11. | Defines the boundary between "staged" and "open". |
| New phase — verify `npx hardhat upgrade --validate` (or OZ upgrades-core) returns zero failures before any production upgrade. | New "Phase 11.5". | Catches future regressions of ATS-09. |

---

*— end of report —*
