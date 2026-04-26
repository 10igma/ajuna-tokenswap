# Threat Model

This document enumerates the actors that interact with Ajuna Tokenswap and their capabilities, prerequisites, mitigations, and residual risk. It is the precondition for the findings in [REPORT.md](REPORT.md); each finding cross-references the actor(s) whose capability set it expands or whose mitigation it weakens.

## Asset inventory

| Asset | Custodian | Source of authority |
|-------|-----------|---------------------|
| Locked AJUN (foreign asset) | `AjunaWrapper` proxy | `IERC20Precompile.balanceOf(wrapper)` |
| Outstanding wAJUN supply | `AjunaERC20` proxy storage | `totalSupply()` |
| User wAJUN balance | `AjunaERC20` proxy storage | `balanceOf(user)` |
| `AjunaWrapper.owner()` | EOA → multisig (post hand-off) | `Ownable2StepUpgradeable` |
| `AjunaERC20.defaultAdmin()` | EOA → multisig (post hand-off, with delay) | `AccessControlDefaultAdminRulesUpgradeable` |
| `MINTER_ROLE` on `AjunaERC20` | `AjunaWrapper` proxy | `AccessControl.grantRole`/`revokeRole` |
| `UPGRADER_ROLE` on `AjunaERC20` | EOA → multisig (post hand-off) | `AccessControl.grantRole`/`revokeRole` |
| Existential deposit (DOT and AJUN dust) on the wrapper proxy account | Substrate runtime | `pallet-balances` / `pallet-assets` reaping rules |

## Actor matrix

### A1. Honest user (allowlisted or post-Phase-11 public)

- **Capabilities:** `deposit`, `withdraw`, ERC20 transfer/approve of wAJUN, view functions.
- **Prerequisites:** AJUN balance, AJUN approval to wrapper, optional wAJUN approval to wrapper for withdraw.
- **Mitigations:** none required — this is the intended user.
- **Residual risk:** approval-race on wAJUN/AJUN (standard ERC20 surface; out of contract scope).

### A2. Curious / greedy user

- **Capabilities (attempted):** front-running of allowlist toggles, sandwiching deposit/withdraw, dust-spam of `setAllowlist`-callable surface, attempting reentrancy via callback hooks.
- **Prerequisites:** ability to monitor mempool / post-state.
- **Mitigations:** `nonReentrant` on `deposit`/`withdraw`; allowlist gate is owner-only so attacker cannot self-grant; the wrapper has no approve-set mempool griefing surface beyond the underlying ERC20.
- **Residual risk:** **read-only reentrancy** on `isInvariantHealthy()` if the foreign asset is malicious (ATS-11). Allowlist toggles are owner-controlled — this actor cannot DoS them.

### A3. Allowlisted attacker (privilege-escalation attempt)

- **Capabilities:** anything A1 can do, plus the ability to deposit while the gate is up.
- **Prerequisites:** owner adds them.
- **Mitigations:** allowlist grants only `deposit` access — no admin paths. `withdraw` is permissionless either way.
- **Residual risk:** none over A1. Allowlisting is functionally a positive ACL with no over-grant.

### A4. Pre-hand-off owner / deployer EOA

- **Capabilities:** all of `pause`/`unpause`, `rescueToken`, `setAllowlist*`, `transferOwnership` on the wrapper; full `DEFAULT_ADMIN_ROLE` + `UPGRADER_ROLE` on the ERC20 — including `grantRole(MINTER_ROLE, attacker)` and `upgradeToAndCall(maliciousImpl, …)`.
- **Prerequisites:** key custody.
- **Mitigations:** `_disableInitializers()` on implementations; `Ownable2Step` + 5-day delayed `DEFAULT_ADMIN_ROLE` transfer prevent typo-irreversibility; the production checklist demands hand-off + renounce in Phase 8/9.
- **Residual risk:** this is the most dangerous actor in the system before hand-off. Compromise = full system compromise. The deployer can mint unbacked wAJUN at will because they hold the role that grants `MINTER_ROLE`. The hand-off must happen and be verified. **ATS-01 (broken `deploy_production.sh` post-deploy guidance) directly extends this actor's window of exposure** because operators following the script will fail to complete the ERC20 admin hand-off and silently retain the role on the deployer EOA.

### A5. Post-hand-off owner (multisig / governance)

- **Capabilities:** identical to A4, with the additional latency cost of multisig signing.
- **Prerequisites:** signer-quorum compromise.
- **Mitigations:** multisig threshold (3-of-5 / 4-of-7 recommended in `docs/SECURITY.md`); recommended timelock in front (not currently deployed — operational concern).
- **Residual risk:** centralization. The multisig can mint unbacked wAJUN, drain non-foreign-asset rescuable balances, upgrade to malicious code, and (most subtly) move the wrapper owner and ERC20 default admin **independently** because the contracts do not enforce that they remain the same address (ATS-04).

### A6. Pending owner mid two-step transfer

- **Capabilities:** none on the contract until they call `acceptOwnership()`. The current owner retains full power.
- **Prerequisites:** owner started the transfer.
- **Mitigations:** `pendingOwner` cannot pause, rescue, upgrade, or even cancel — only the current owner can re-target by re-calling `transferOwnership`.
- **Residual risk:** none — this is the intended typo-recovery property. Verified in `test/wrapper.test.ts` "should allow cancelling a pending ownership transfer".

### A7. `MINTER_ROLE` holder (other than the wrapper)

- **Capabilities:** `mint`/`burnFrom` on `AjunaERC20` — i.e., create unbacked wAJUN at will and burn arbitrary holders' tokens (within their allowance).
- **Prerequisites:** `DEFAULT_ADMIN_ROLE` granted them this role.
- **Mitigations:** the deployment script grants `MINTER_ROLE` only to the wrapper proxy. Production-checklist Phase 5 requires verifying this. **Nothing on-chain prevents the admin from later granting `MINTER_ROLE` to any other address.**
- **Residual risk:** the multisig is fully trusted not to grant additional `MINTER_ROLE` holders. Off-chain monitor on the `RoleGranted` event recommended; not enforced. ATS-04 PoCs this against a misconfigured hand-off.

### A8. `UPGRADER_ROLE` holder (other than the wrapper owner)

- **Capabilities:** `upgradeToAndCall` on `AjunaERC20` to any non-EOA implementation. Can replace mint/burn semantics, drain balances via a malicious `_authorizeUpgrade` chain, etc.
- **Prerequisites:** `DEFAULT_ADMIN_ROLE` granted them this role.
- **Mitigations:** intended sole holder is the multisig; deployer renounces in Phase 9B.
- **Residual risk:** equivalent to multisig compromise. The OZ upgrades-core plugin would refuse to validate an upgrade to the current implementation due to ATS-09, so an operator using `hardhat-upgrades` for the upgrade would see it fail before broadcasting; one using raw `upgradeToAndCall` would not.

### A9. `DEFAULT_ADMIN_ROLE` holder

- **Capabilities:** grant/revoke `MINTER_ROLE` and `UPGRADER_ROLE` to anyone, single-step. Initiate the two-step delayed transfer of `DEFAULT_ADMIN_ROLE` itself.
- **Prerequisites:** key custody / multisig quorum.
- **Mitigations:** 5-day delay on `DEFAULT_ADMIN_ROLE` transfer; cancellable; exactly-one-admin invariant from `AccessControlDefaultAdminRulesUpgradeable`.
- **Residual risk:** the most powerful role on the ERC20. Independently as dangerous as A5 (wrapper owner) for the backing invariant — see ATS-04.

### A10. Holder of a malicious implementation contract proposed via upgrade

- **Capabilities:** post-upgrade, executes arbitrary code as the proxy. Can read/write all storage, mint/burn arbitrarily, redirect `foreignAsset`, drain treasury.
- **Prerequisites:** A5 or A8 must call `upgradeToAndCall` with the malicious implementation address.
- **Mitigations:** `_authorizeUpgrade` is `onlyOwner`/`onlyRole(UPGRADER_ROLE)`; `code.length > 0` check rejects EOA targets (ATS-10 caveats).
- **Residual risk:** nothing on-chain protects against the upgrader signing a bad upgrade. Recommended timelock + post-upgrade pause + monitoring.

### A11. Self-destructible / replaceable implementation

- **Capabilities (post-upgrade):** if a bad implementation is `SELFDESTRUCT`-able, the proxy could be left pointing at empty code and effectively bricked.
- **Prerequisites:** the upgrade target contains `selfdestruct`. On EVM mainnet (Cancun + EIP-6780), `SELFDESTRUCT` is a no-op for non-creation contracts, so this risk is gone post-Cancun. On PVM (`pallet-revive`) the equivalent semantics are not specified by the contract assumption.
- **Mitigations:** the `code.length > 0` check at `_authorizeUpgrade` time only verifies that *at the moment of the upgrade* the target is non-empty — it cannot prevent later code clearing.
- **Residual risk:** ATS-10 — flag as PVM-specific assumption.

### A12. Substrate runtime (account reaping)

- **Capabilities:** if the wrapper proxy account falls below the existential deposit (DOT) or holds zero of the foreign asset for too long, the account record is reaped. Subsequent re-creation does not recover the locked asset balance.
- **Prerequisites:** wrapper not seeded per Phase 6A/6B of the production checklist.
- **Mitigations:** Phase 6 of the production checklist explicitly demands seeding 0.1 DOT and 100 dust AJUN.
- **Residual risk:** if the operator skips Phase 6 — or if the AJUN dust is later withdrawn through some path — the wrapper account can be reaped. There is no on-chain guard. Filed as INFO with explicit operational dependency on the checklist.

### A13. Frontend-poisoning attacker

- **Capabilities:** trick a user into approving a malicious "wrapper" address (via URL parameters in `frontend/app.html?wrapper=0x…`).
- **Prerequisites:** user opens a poisoned link; user does not verify approval target.
- **Mitigations:** none in the contract layer. The frontend reads addresses from URL params unconditionally (per `deployments.config.ts` defaults being empty post-deploy).
- **Residual risk:** out of strict contract scope but worth flagging — the URL-parameter override pattern doubles as a phishing vector. INFO.

### A14. Malicious foreign asset (only relevant if `foreignAsset` was set to an attacker-controlled address at init time)

- **Capabilities:** can return false on transfers, charge fees, re-enter `deposit` / `withdraw`, lie about `balanceOf`, etc.
- **Prerequisites:** the deployer initialized the wrapper with a wrong / malicious `_foreignAssetPrecompile`.
- **Mitigations:** SafeERC20 catches false-return; balance-delta re-read in `deposit` (LOW-1 fix) catches fee-on-transfer; `nonReentrant` catches reentrancy. Address is immutable after init (only changeable via UUPS upgrade).
- **Residual risk:** any malicious behavior the precompile can mount post-init is bounded by these defenses. The two genuinely scary cases are:
  - `balanceOf` lies *during* the deposit → mints incorrect amount (ATS-11 read-only reentrancy is a related observation).
  - Future runtime upgrade introduces fee-on-transfer behavior — already mitigated by LOW-1.

## Trust assumptions (must hold for the system to be safe)

| # | Assumption | Source | Verifiability |
|---|-----------|--------|--------------|
| T1 | The address passed to `_foreignAssetPrecompile` at init is the canonical AJUN ERC20 precompile and has been verified by the operator using `scripts/lookup_ajun_asset.ts`. | Production checklist Phase 2 | On-chain: read `wrapper.foreignAsset()` post-deploy. |
| T2 | The AJUN precompile conforms to the standard ERC20 trait, never charges a transfer fee, never rebases, and never returns `false` on success. | `IERC20Precompile.sol` interface declaration; runtime contract. | Off-chain: cannot be statically asserted of `pallet-revive` precompile. |
| T3 | The PVM (`pallet-revive`) faithfully implements `extcodesize` semantics, has no path to clear a non-zero-code address, and either does not implement `SELFDESTRUCT` or treats it as a no-op for non-creation contracts (post-EIP-6780 EVM behavior). | Implicit in `_authorizeUpgrade`'s `code.length > 0` check. | Cross-reference: needs PVM specification; not documented in repo. |
| T4 | The wrapper proxy substrate account is seeded per Phase 6 (DOT ED + AJUN dust) and operators retain the dust permanently. | Production checklist Phase 6. | Off-chain monitor. |
| T5 | `wrapper.owner()` and `erc20.defaultAdmin()` are the same multisig, and that multisig will not (a) grant `MINTER_ROLE` to anyone other than the wrapper, (b) grant `UPGRADER_ROLE` outside the multisig, or (c) approve a malicious upgrade. | Implicit in the design; partially documented in checklist Phase 9C as an off-chain monitor recommendation. | Off-chain monitor only — **not enforced on-chain (ATS-04)**. |
| T6 | The OZ contracts library is at exactly v5.6.1, where `ReentrancyGuard` and `UUPSUpgradeable` are stateless / namespaced. A v6.0 bump (planned per OZ deprecation note) switches `ReentrancyGuard` to transient storage; this requires PVM EIP-1153 support. | Implicit in inheritance choices. | Verifiable by `package-lock.json`. **Triggers ATS-09 if dependency is bumped without re-audit.** |
| T7 | The deployer EOA renounces all roles per Phase 9 of the production checklist, *not* per `scripts/deploy_production.sh` (which contains broken instructions — ATS-01). | Production checklist Phase 9; broken in `deploy_production.sh`. | Off-chain — verify `token.hasRole(DEFAULT_ADMIN_ROLE, deployer) == false` and `wrapper.owner() != deployer` post-Phase-9. |
| T8 | Pause is timely. There is no on-chain timelock between vulnerability disclosure and the multisig signing `pause()`. | Implicit. | Operational. |

If any of T1–T8 fails, at least one finding becomes more severe. Each finding's "Affected actors" line names the trust assumption it leans on.
