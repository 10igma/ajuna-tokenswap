# Chopsticks Rehearsal

End-to-end production-flow rehearsal against a Chopsticks-forked Polkadot
Asset Hub. The rehearsal exercises every step of [PRODUCTION-CHECKLIST.md](PRODUCTION-CHECKLIST.md)
end to end and asserts the audit-baseline properties from [REPORT.md](../audit/REPORT.md):
deposit-only allowlist gating (MED-1), `bindMinter` coupling (ATS-04),
decimals coherence (ATS-08), inline reentrancy guard (ATS-09), two-step +
delayed admin handoff (REVIEW_v1 M-A + audit MED-2), permissionless
withdraw, and the 1:1 backing invariant.

If the rehearsal passes against the live AJUN precompile address on a
forked mainnet, the same code+flow will pass against the real mainnet
deploy. **Run this immediately before any mainnet deploy** and any time
the AJUN runtime configuration changes.

## ⚠ Known limitation: Chopsticks vs. EthSetOrigin (Phases 3+ skipped today)

The current Polkadot Asset Hub mainnet runtime uses a `EthSetOrigin`
signed extension to route the H160 → AccountId mapping at the
fee-payment layer for `pallet-revive` EVM transactions. Chopsticks
does not yet recognise this extension and treats it as a no-op:

```
REGISTRY: Unknown signed extensions AuthorizeCall, EthSetOrigin,
StorageWeightReclaim found, treating them as no-effect
```

With `EthSetOrigin` disabled, every EVM transaction Chopsticks sees
fails substrate-side payment validation with
`{"invalid":{"payment":null}}` (`InvalidTransaction::Payment`),
regardless of how the deployer is funded. **This is an upstream
Chopsticks limitation, not a contract bug.**

### What still gets verified

Phases 0-2 produce real, valuable verification:

- ✓ Mainnet eth-RPC URL is correct (`https://eth-rpc.polkadot.io/`)
- ✓ Mainnet chain ID is correct (`420420419`)
- ✓ AJUN precompile reachable at the recorded address
- ✓ Precompile `decimals()` returns 12
- ✓ Precompile `totalSupply()` is readable
- ✓ `dev_setStorage` funding pattern (DOT + AJUN) takes effect

### How to complete end-to-end verification today

1. **Contract logic** is independently verified by the 112 Hardhat
   unit tests + audit PoC regression tests in `test/audit/`:
   ```bash
   npx hardhat test
   npx --yes @openzeppelin/upgrades-core validate artifacts/build-info
   ```
2. **PVM bytecode + gas behaviour** — run `./scripts/e2e_local.sh`
   against `revive-dev-node`.
3. **Real-precompile interaction at deploy time** — rely on
   [PRODUCTION-CHECKLIST.md](PRODUCTION-CHECKLIST.md) **Phase 7**:
   mainnet smoke test under the allowlist gate. Only the deployer +
   explicitly-allowlisted testers can interact, so the operational
   risk is bounded.

### When the full rehearsal will work again

When Chopsticks adds support for `EthSetOrigin` (and the other new
signed extensions), or when an alternative forking tool that handles
the current Polkadot Asset Hub signed-extension set is adopted. The
rehearsal script will run all 11 phases automatically once that
happens — no further changes needed.

## What it does

The rehearsal automates 11 phases:

| Phase | What it verifies |
|-------|------------------|
| 0 | Connectivity to Chopsticks (substrate WS) and eth-rpc adapter |
| 1 | AJUN precompile is reachable; reads `decimals()` and `totalSupply()` |
| 2 | Funds deployer + tester with AJUN, all four test accounts with DOT, via `dev_setStorage` |
| 3 | Inline deploy: AjunaERC20 + AjunaWrapper + bindMinter |
| 4 | Post-deploy: wrapper holds MINTER_ROLE, decimals match, allowlist on, owner == admin == deployer |
| 5 | Phase-6B seed: deployer deposits AJUN dust (owner short-circuits allowlist) |
| 6 | Allowlisted tester wraps + unwraps; invariant remains exact |
| 7 | Stranger (non-allowlisted) cannot deposit while gate is on (MED-1 negative path) |
| 8 | `transferOwnership` + `beginDefaultAdminTransfer` to multisig stand-in |
| 9 | Wait `ADMIN_DELAY_SECS`, then `acceptOwnership` + `acceptDefaultAdminTransfer` |
| 10 | Multisig calls `setAllowlistEnabled(false)`; previously-blocked stranger now wraps + unwraps |
| 11 | Final invariant check: `isUnderCollateralized() == false`, `getInvariantDelta() == 0` |

The total wall-clock time is roughly `ADMIN_DELAY_SECS + 30s` (default: ~90s).

## Prerequisites

You need three things running locally:

1. **Chopsticks** forking Polkadot Asset Hub mainnet.
2. **eth-rpc adapter** translating EVM JSON-RPC ↔ substrate.
3. **Node + npm dependencies** installed (`npm install --legacy-peer-deps`).

You also need a built `eth-rpc` binary. The repo's `polkadot-sdk/` subtree
contains the source; the [QUICKSTART.md](QUICKSTART.md) has the build
instructions.

## Step-by-step

### 1. Start Chopsticks (terminal 1)

```bash
npx @acala-network/chopsticks --config=chopsticks.yml
```

This forks Polkadot Asset Hub mainnet at the latest finalized block and
serves the substrate WS on `ws://127.0.0.1:8000`. Wait for the line
`Chopsticks server is running on port 8000` before continuing.

### 2. Start eth-rpc (terminal 2)

```bash
./polkadot-sdk/target/release/eth-rpc --node-rpc-url ws://127.0.0.1:8000
```

This serves the EVM-compatible JSON-RPC on `http://127.0.0.1:8545`. Wait
for the startup banner before continuing.

### 3. (Optional) Re-verify the AJUN precompile address

```bash
npx ts-node scripts/lookup_ajun_asset.ts ws://127.0.0.1:8000
```

Confirm the precompile address matches the recorded
`0x0000002d00000000000000000000000002200000`. If it doesn't, the runtime
has shifted since the audit and you must investigate before proceeding.

### 4. Run the rehearsal (terminal 3)

```bash
./scripts/chopsticks_rehearsal.sh
```

The script:
- Verifies both ports are reachable.
- Invokes `npx hardhat run scripts/chopsticks_rehearsal.ts --network chopsticks`.
- Prints a phase-by-phase progress log.
- Exits 0 on success, 1 on any failure with a `✗ REHEARSAL FAILED` line.

> **Note on the `chopsticks` Hardhat network**: same RPC URL as `local`
> (`http://127.0.0.1:8545`) but `chainId: 420420419` — the chain ID the
> eth-rpc adapter reports against forked Asset Hub mainnet. The `local`
> network is for the pure `revive-dev-node` (chainId `420420420`); they
> are not interchangeable.

### Expected output (last lines)

```
═══════════════════════════════════════════════════════════════════
  REHEARSAL PASSED
═══════════════════════════════════════════════════════════════════

  Production-flow rehearsal complete. Audit-baseline properties verified
  against forked Polkadot Asset Hub state:

    - AJUN precompile reachable at 0x0000002d00000000000000000000000002200000
    - Decimals coherence (audit ATS-08) holds
    - bindMinter coupling (audit ATS-04) holds
    - Allowlist gates deposit only (audit MED-1) — withdraw remains
      permissionless even with the gate on
    - Two-step + delayed admin handoff (REVIEW_v1 M-A + audit MED-2) works
    - Phase-11 open-up → public wrap/unwrap works
    - Backing invariant intact

  Recorded addresses:
    ERC20:    0x...
    Wrapper:  0x...
    Multisig (stand-in): 0x...
    Tester (stand-in):   0x...
```

## Environment overrides (rare)

| Variable | Default | Purpose |
|----------|---------|---------|
| `FOREIGN_ASSET` | `0x0000002d00000000000000000000000002200000` | Override the AJUN precompile address (e.g. for testnet rehearsals). |
| `ADMIN_DELAY_SECS` | `60` | Override the rehearsal admin transfer delay. **Production deploys use 432000 (5 days)** — this short value is rehearsal-only. |
| `SUBSTRATE_WS` | `ws://127.0.0.1:8000` | Override the Chopsticks substrate WS endpoint. |
| `ETH_RPC` | `http://127.0.0.1:8545` | Override the eth-rpc adapter endpoint. |

## Troubleshooting

### "Chopsticks not reachable on 127.0.0.1:8000"

Chopsticks isn't running, or it's bound to a different port. Confirm with
`netstat -ln | grep 8000`. Restart per Step 1 above.

### "AJUN precompile not reachable at 0x..."

Either the precompile address has changed (check via `lookup_ajun_asset.ts`)
or the foreign-asset pallet isn't on the forked runtime. Both should be
true on current Polkadot Asset Hub mainnet — investigate the runtime
version mismatch before proceeding.

### "Deployer AJUN balance is 0 after dev_setStorage"

The `dev_setStorage` payload uses pallet/storage names (`ForeignAssets.Account`)
that depend on the runtime's pallet structure. If the forked runtime has
renamed `ForeignAssets`, the call silently does nothing. Inspect the
runtime metadata via Polkadot.js Apps connected to `ws://127.0.0.1:8000`
and adjust [`scripts/chopsticks_rehearsal.ts`](../scripts/chopsticks_rehearsal.ts)
accordingly.

### Phase 9 takes longer than `ADMIN_DELAY_SECS + 2`

Chopsticks produces blocks on demand. The rehearsal's polling loop nudges
new blocks via small delays; if Chopsticks is configured with `block: <N>`
or another mode that disables on-demand block production, the timestamp
may not advance fast enough. Either remove the block override from
[chopsticks.yml](../chopsticks.yml) or increase `ADMIN_DELAY_SECS`.

### Phase 11 invariant check fails (`isUnderCollateralized = true`)

This would be a real audit-baseline regression. Stop, do not deploy to
mainnet, and investigate. The likely candidates are:
- A bug introduced in the `deposit` or `withdraw` flow.
- A change in the precompile's `transferFrom` semantics (e.g. fee-on-transfer)
  that the LOW-1 balance-delta defense should catch but didn't.

## What the rehearsal does NOT cover

- **External wallet integration** — MetaMask / SubWallet / Talisman. Do
  these manually pre-launch via the dApp.
- **Real multisig flow** — the stand-in is an `ethers.Wallet`, not a Safe
  / Polkadot multisig contract. Real multisig handoff has additional
  signing-quorum considerations covered by the multisig handoff rehearsal
  (separate doc, future work).
- **Timelock delay** — production should have `TimelockController` in
  front of the multisig (audit INFO-B; not yet deployed in this repo).
- **XCM teleport** — getting AJUN onto Asset Hub from the Ajuna parachain
  is the user-side prerequisite; out of scope for the wrapper rehearsal.
- **Frontend** — the dApp at `frontend/app.html` is not exercised here.

## Re-running

The rehearsal is idempotent in the sense that each invocation deploys
fresh contracts on the (also fresh, post-restart) Chopsticks fork. To
re-run cleanly:

1. Stop Chopsticks (Ctrl-C in terminal 1).
2. Restart Chopsticks (Step 1).
3. Restart eth-rpc (Step 2; some versions reconnect automatically).
4. Run the rehearsal again.

If you need to keep the same forked state across multiple rehearsals
(e.g. comparing two contract versions side by side), Chopsticks has a
`save-blocks` / `load-blocks` feature — see its docs.
