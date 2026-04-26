# Production Rollout Checklist

This checklist is intended for operators and AI agents performing or auditing a production deployment of Ajuna Tokenswap on Polkadot Asset Hub.

It is deliberately procedural. Follow it top to bottom.

## Fixed Production Facts

- Network: `polkadotMainnet`
- Chain: Polkadot Asset Hub
- EVM RPC: `https://polkadot-asset-hub-eth-rpc.polkadot.io`
- WS RPC: `wss://polkadot-asset-hub-rpc.polkadot.io`
- Runtime version observed when AJUN precompile was verified: `2002001`
- AJUN MultiLocation: `{ parents: 1, interior: { X1: [{ Parachain: 2051 }] } }`
- AJUN foreign-asset precompile index: `45`
- AJUN foreign-asset precompile address: `0x0000002d00000000000000000000000002200000`

## Fill-In Block

Complete this block during rollout.

```text
Date:
Operator:
AI Agent:
Git commit:
Deployer EOA:
Multisig / governance address:
AJUN precompile address used:
AjunaERC20 proxy address:
AjunaERC20 implementation address:
AjunaWrapper proxy address:
AjunaWrapper implementation address:
Deployment tx hashes:
Verification tx hashes:
Notes:
```

## Phase 1: Preflight

- [ ] Confirm local workspace is on the intended git commit.
- [ ] Confirm dependencies are installed.

```bash
npm install --legacy-peer-deps
```

- [ ] Confirm contracts compile.

```bash
npx hardhat compile
```

- [ ] Confirm unit tests pass.

```bash
npx hardhat test
```

- [ ] Confirm the operator can access the production deployer key via Hardhat vars.

```bash
npx hardhat vars get PRIVATE_KEY
```

- [ ] Confirm the deployer account has enough DOT for deployment and follow-up transactions.
- [ ] Confirm the target multisig or governance address is finalized before deployment.
- [ ] Confirm no one plans to use implementation addresses directly.

## Phase 2: Live Chain Confirmation

Reconfirm the AJUN precompile against live chain state before sending any deployment transaction.

- [ ] Re-run the lookup script.

```bash
npx ts-node scripts/lookup_ajun_asset.ts
```

- [ ] Confirm all of the following are true in the output:
  - AJUN is registered as a foreign asset.
  - `assetsPrecompiles` pallet is present.
  - AJUN precompile index resolves successfully.
  - The reported precompile address is `0x0000002d00000000000000000000000002200000`.

- [ ] If the output differs, stop and use the live output as ground truth.

## Phase 3: Optional Dry Run On Fork

If time permits, run a final production-like rehearsal before mainnet deployment.

- [ ] Start Chopsticks.

```bash
npx @acala-network/chopsticks --config=chopsticks.yml
```

- [ ] Start the `eth-rpc` adapter if required.

```bash
./polkadot-sdk/target/release/eth-rpc --node-rpc-url ws://127.0.0.1:8000
```

- [ ] Reconfirm AJUN precompile on forked state.

```bash
npx ts-node scripts/lookup_ajun_asset.ts ws://127.0.0.1:8000
```

- [ ] If running a dry run, deploy with the same `FOREIGN_ASSET` value intended for production.

## Phase 4: Production Deployment

Canonical production foreign asset value:

```bash
FOREIGN_ASSET=0x0000002d00000000000000000000000002200000
```

Choose one deployment path.

- [ ] Option A: interactive helper.

```bash
FOREIGN_ASSET=0x0000002d00000000000000000000000002200000 ./scripts/deploy_production.sh
```

- [ ] Option B: direct deploy.

```bash
FOREIGN_ASSET=0x0000002d00000000000000000000000002200000 npx hardhat run scripts/deploy_wrapper.ts --network polkadotMainnet
```

- [ ] Record the emitted proxy addresses.
- [ ] Record the transaction hashes.
- [ ] Record implementation addresses if exposed during the session or recovered from deployment traces.

## Phase 5: Immediate Post-Deploy Checks

These checks should happen before announcing the deployment as ready.

- [ ] Confirm `AjunaWrapper` was initialized with the correct token proxy and AJUN precompile address.
- [ ] Confirm `AjunaERC20` name and symbol are correct.
- [ ] Confirm decimals are `12`.
- [ ] Confirm the wrapper has `MINTER_ROLE` on the token.
- [ ] Confirm all user-facing references use proxy addresses, not implementation addresses.
- [ ] Confirm `wrapper.allowlistEnabled() == true`. The wrapper ships with the
      allowlist gate ON by default — the deployer (and later the multisig
      after `acceptOwnership`) is implicitly allowed; everyone else is
      blocked from `deposit` / `withdraw` until added or the gate is opened.

## Phase 6: Existential Deposit Protection

The wrapper needs substrate-level survivability.

### 6A. Seed Native DOT

- [ ] Send native DOT to the wrapper proxy address using a substrate transfer.
- [ ] Recommended amount: `0.1 DOT`.
- [ ] Use `balances.transferKeepAlive`, not a Solidity native transfer.

Reference:

```text
balances.transferKeepAlive(dest: <wrapper_proxy>, value: 1_000_000_000)
```

### 6B. Seed AJUN Asset Balance

- [ ] Approve the wrapper to spend a small AJUN amount from an admin-controlled account.
- [ ] Call `deposit()` with a small amount.
- [ ] Keep that seeded balance in the wrapper so the AJUN asset account is not reaped.

Suggested minimum operational seed:
- `100` smallest AJUN units or whatever amount operations defines as permanent dust

## Phase 7: Functional Verification (Allowlist-Gated)

The allowlist gate is still ON at this point. Smoke-test on production
under the gate so unrelated wallets cannot interact while you verify.

- [ ] Add the operator (or designated tester) accounts to the allowlist:

```text
wrapper.setAllowlist(<tester>, true)
// or for a cohort:
wrapper.setAllowlistBatch([<tester1>, <tester2>, ...], true)
```

- [ ] Run a small wrap/unwrap verification on production.

```bash
WRAPPER_ADDRESS=0x... ERC20_ADDRESS=0x... FOREIGN_ASSET=0x0000002d00000000000000000000000002200000 \
  npx hardhat run scripts/e2e_test.ts --network polkadotMainnet
```

- [ ] Confirm deposit succeeds.
- [ ] Confirm withdraw succeeds.
- [ ] Confirm balances match expectations.
- [ ] Confirm the backing invariant still holds.

Target invariant:

```text
wAJUN.totalSupply() == AJUN.balanceOf(wrapper)
```

## Phase 8: Admin Handoff

Do not leave long-term admin control on the deployer EOA.

- [ ] Grant `DEFAULT_ADMIN_ROLE` on `AjunaERC20` to multisig.
- [ ] Grant `UPGRADER_ROLE` on `AjunaERC20` to multisig.
- [ ] Transfer `AjunaWrapper` ownership to multisig.
- [ ] Verify the multisig can perform expected admin reads or dry-run calls.

## Phase 9: Deployer Privilege Removal

- [ ] Renounce deployer `DEFAULT_ADMIN_ROLE` on `AjunaERC20`.
- [ ] Renounce deployer `UPGRADER_ROLE` on `AjunaERC20`.
- [ ] Confirm wrapper ownership no longer belongs to deployer.

## Phase 10: Frontend and Ops Update

- [ ] Update frontend configuration with the deployed proxy addresses.
- [ ] Confirm the UI points at the AJUN foreign-asset precompile address, not a mock token.
- [ ] Update operational runbooks with proxy addresses, tx hashes, and multisig ownership status.
- [ ] Store final addresses somewhere durable.

## Phase 11: Open To Public

Only execute once all prior phases are green and the multisig is comfortable.

- [ ] Multisig calls `wrapper.setAllowlistEnabled(false)` on production.
- [ ] Confirm event `AllowlistEnabledUpdated(false)` emitted in the tx receipt.
- [ ] Confirm an external (non-allowlisted) test account can now `deposit`.
- [ ] Announce.

If anything goes wrong post-launch, multisig can re-gate immediately
with `setAllowlistEnabled(true)`. This is reversible and strictly more
surgical than `pause()` — useful for blocking individual addresses
later via `setAllowlist(target, false)` without freezing legitimate users.

## Phase 12: Final Sign-Off

Only mark production ready when all items below are true.

- [ ] AJUN live precompile was verified immediately before deployment.
- [ ] Contracts deployed successfully.
- [ ] Proxy addresses recorded.
- [ ] Wrapper funded with native DOT for ED safety.
- [ ] Wrapper seeded with permanent AJUN dust (under allowlist).
- [ ] Production wrap/unwrap smoke test passed (under allowlist).
- [ ] Admin roles moved to multisig.
- [ ] Deployer privileges removed.
- [ ] Frontend and operational config updated.
- [ ] Allowlist gate disabled by multisig — production is open to public.

## Abort Conditions

Stop and do not continue if any of these happens:

- The lookup script reports a different AJUN precompile address.
- The deployment output does not clearly identify the proxy addresses.
- The wrapper does not receive `MINTER_ROLE`.
- A smoke-test deposit or withdrawal fails.
- Multisig handoff cannot be completed.
- The team cannot confirm which addresses are proxies versus implementations.

## Minimal Command Set

For a compact operator flow:

```bash
npx ts-node scripts/lookup_ajun_asset.ts
npx hardhat compile
npx hardhat test
FOREIGN_ASSET=0x0000002d00000000000000000000000002200000 ./scripts/deploy_production.sh
WRAPPER_ADDRESS=0x... ERC20_ADDRESS=0x... FOREIGN_ASSET=0x0000002d00000000000000000000000002200000 \
  npx hardhat run scripts/e2e_test.ts --network polkadotMainnet
```

## One-Line Operational Summary

Deploy using `FOREIGN_ASSET=0x0000002d00000000000000000000000002200000`, verify proxy addresses, seed ED and AJUN dust immediately, smoke-test wrap/unwrap, then transfer all control to multisig.
