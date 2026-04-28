# Continuous Integration

GitHub Actions runs on every push to `main` and every pull request targeting
`main`. The workflow is at [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).

## What CI enforces

Two parallel jobs, both must pass for the PR to be mergeable.

### Job 1 — `Compile / Test / OZ Validate`

| Step | Command | Why |
|------|---------|-----|
| Compile | `npx hardhat compile` | Catches Solidity errors / dependency drift. |
| Test | `npx hardhat test` | Full Hardhat suite (currently 119). The audit-PoC tests in [`test/audit/`](../test/audit/) are part of this run — regressing any audit fix surfaces here. |
| OZ validate | `npx --yes @openzeppelin/upgrades-core validate artifacts/build-info` | Catches regressions of audit ATS-09 (the inline-reentrancy-guard switch). Currently passes 4 / 4 upgradeable contracts. |

### Job 2 — `Slither static analysis`

| Tool | Configuration | Why |
|------|---------------|-----|
| [crytic/slither-action@v0.4.0](https://github.com/crytic/slither-action) | [`slither.config.json`](../slither.config.json) (`fail_on: high`, `filter_paths: node_modules\|contracts/mocks`, `detectors_to_exclude: naming-convention`) | Static analysis on every commit. Any high-severity finding fails CI. Medium and below are reported as annotations but do not fail. |

## Suppressions

The current baseline has **zero high-severity findings** in the in-scope
codebase. All slither options live in [`slither.config.json`](../slither.config.json) so
CI and local runs stay in sync. The known non-failing items:

- **`incorrect-equality` on [`AjunaWrapper.isInvariantHealthy`](../contracts/AjunaWrapper.sol)** — suppressed via a per-line
  `// slither-disable-next-line incorrect-equality` annotation. The strict
  equality is intentional ("is the backing exactly 1:1?"); off-chain monitors
  that need direction should call [`isUnderCollateralized()`](../contracts/AjunaWrapper.sol)
  (audit ATS-12 sister view).
- **`naming-convention`** — excluded globally via `detectors_to_exclude`. The
  codebase uses the OpenZeppelin convention (leading underscore for `_token`,
  `_foreignAssetPrecompile`, `__gap`, …) which slither flags as non-mixedCase.
- **`node_modules` and `contracts/mocks` filtered** via `filter_paths`. Third-party
  dependencies are not in our audit scope, and the mocks under `contracts/mocks/`
  are intentionally misbehaving ERC20s used only by the test suite. Without
  this filter slither reports false-positive HIGHs on OpenZeppelin's
  `Math.mulDiv` (`incorrect-exp` misreads `^` XOR as exponentiation) and
  `TimelockController._execute` (`arbitrary-send-eth` — by design for a
  timelock).

## What this gate prevents

The CI baseline locks in every audit fix. Concretely, the following
regressions would fail CI immediately:

| Regression | Caught by |
|-----------|-----------|
| Removing `bindMinter` enforcement on `MINTER_ROLE` (audit ATS-04) | "Role Management" + bindMinter test groups in `wrapper.test.ts` |
| Re-introducing `onlyAllowedUser` on `withdraw` (audit MED-1) | "Allowlist" group `should NOT gate withdraw` test |
| Re-introducing OZ `ReentrancyGuard` parent (audit ATS-09) | OZ upgrades-core validate fails |
| Removing `nonReentrantView` from invariant views (audit ATS-11) | `audit/readonly_reentrancy.test.ts` |
| Skipping decimals coherence check (audit ATS-08) | "Decimals coherence" test |
| Reverting `__gap` to `[46]` (audit ATS-05) | Storage tables in `audit/storage-layout.md` (regenerated CI step would diff) |
| Single-step admin handoff on the ERC20 (audit MED-2) | "Admin Handoff" test group |
| Removing `Ownable2Step` from the wrapper (REVIEW_v1 M-A) | "Ownership Transfer" test group |
| Restoring the broken `deploy_production.sh` printout (audit ATS-01) | Not detected automatically — visual review only |

The visual-review-only items are flagged in [docs/PRODUCTION-CHECKLIST.md](PRODUCTION-CHECKLIST.md)
Phase 4 with explicit "do not interpret these reverts as `chain busy, retry`"
operator guidance.

## Running CI locally

To reproduce the CI gates before pushing:

```bash
npm install --legacy-peer-deps
npx hardhat compile
npx hardhat test
npx --yes @openzeppelin/upgrades-core validate artifacts/build-info

# Slither (requires Python + pipx slither-analyzer 0.11.5+).
# Picks up slither.config.json from the repo root automatically.
slither .
```

## Future additions (not in this baseline)

These are deliberately deferred. Add when the team is ready:

- **Aderyn** — Rust-based static analyzer; complements Slither with
  different heuristics. Considered low-ROI duplication for now.
- **Foundry invariant fuzzing** — `forge invariant` for the 1:1 backing
  property. The audit recommends this in `audit/REPORT.md` §6. Requires a
  `foundry.toml` setup; one-day project.
- **Storage-layout diff job** — `forge inspect <Contract> storageLayout` on
  every PR, fail if the layout changes without a `// CHANGELOG-storage`
  marker. Catches future ATS-05 / ATS-06 regressions.
- **Echidna / Medusa** — property-based fuzzing with custom invariant
  predicates. Higher value once the contract has more state.
- **Mythril** — symbolic execution. Low ROI on the current contracts
  (small surface, well-tested).
