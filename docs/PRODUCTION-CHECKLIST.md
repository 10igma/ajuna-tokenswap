# Production Rollout Checklist

This checklist is intended for operators and AI agents performing or auditing a production deployment of Ajuna Tokenswap on Polkadot Asset Hub.

It is deliberately procedural. Follow it top to bottom.

## Fixed Production Facts

- Network: `polkadotMainnet`
- Chain: Polkadot Asset Hub
- EVM RPC: `https://eth-rpc.polkadot.io/` (Parity-hosted; chain ID **420420419**)
- Block explorer: `https://blockscout.polkadot.io/`
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

- [ ] Verify the canonical EVM RPC is reachable and returns the expected chain ID:

```bash
curl -sS -X POST https://eth-rpc.polkadot.io/ \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}'
```

  Expected: `{"jsonrpc":"2.0","id":1,"result":"0x190f1b43"}` (= 420420419).
  If the chain ID returned is anything else, **stop**: it means the
  `polkadotMainnet.chainId` in `hardhat.config.ts` is out of date and
  `deploy_production.sh` will fail at signing time with `HardhatError HH101`.

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
- [ ] Confirm `token.boundMinter() == <wrapper proxy address>`. The
      `deploy_wrapper.ts` script calls `bindMinter` to atomically grant
      `MINTER_ROLE` to the wrapper *and* lock out any further
      `MINTER_ROLE` grants — closes audit ATS-04 (divergence-mint).

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

## Phase 8: Admin Handoff (Two-Step + Delayed)

Do not leave long-term admin control on the deployer EOA. Both contracts now
use two-step transfers (Wrapper: `Ownable2Step`; ERC20: `AccessControlDefaultAdminRules`)
specifically so a typo or wrong-but-valid address cannot become irreversible.

### 8A. AjunaERC20 — start the delayed admin transfer

- [ ] Deployer grants `UPGRADER_ROLE` to multisig (single-step, immediate):

```text
token.grantRole(UPGRADER_ROLE, <multisig>)
```

- [ ] Deployer **starts** the `DEFAULT_ADMIN_ROLE` transfer:

```text
token.beginDefaultAdminTransfer(<multisig>)
```

This sets a pending admin and starts a delay timer (production: 5 days /
432000 seconds, configured via `ADMIN_DELAY_SECS` at deploy time). The
deployer remains `DEFAULT_ADMIN_ROLE` holder until the multisig accepts.

- [ ] Verify `token.pendingDefaultAdmin().newAdmin == <multisig>`.

### 8B. AjunaWrapper — start the two-step ownership transfer

- [ ] Deployer initiates wrapper ownership transfer:

```text
wrapper.transferOwnership(<multisig>)
```

This emits `OwnershipTransferStarted` and sets `pendingOwner`. The deployer
retains `owner()` until the multisig accepts.

- [ ] Verify `wrapper.pendingOwner() == <multisig>`.

### 8C. (If a typo is detected) cancel either transfer

- [ ] On the ERC20: `token.cancelDefaultAdminTransfer()`.
- [ ] On the wrapper: re-call `wrapper.transferOwnership(<correct address>)` (or `address(0)` to clear).

## Phase 9: Multisig Acceptance & Deployer Privilege Removal

After the configured delay has elapsed (production: ≥5 days for the ERC20):

### 9A. Multisig accepts both transfers

- [ ] Multisig calls `wrapper.acceptOwnership()`.
- [ ] Multisig calls `token.acceptDefaultAdminTransfer()`.
- [ ] Verify `wrapper.owner() == <multisig>` and `token.defaultAdmin() == <multisig>`.

### 9B. Deployer renounces remaining role

- [ ] Deployer renounces `UPGRADER_ROLE` on `AjunaERC20`:

```text
token.renounceRole(UPGRADER_ROLE, <deployer>)
```

(`DEFAULT_ADMIN_ROLE` was already moved to the multisig atomically in
Phase 9A — no separate renunciation needed.)

- [ ] Confirm `wrapper.owner()` is the multisig and the deployer holds no roles on the ERC20.

### 9C. Optional invariant: wrapper.owner() == ERC20.defaultAdmin()

- [ ] Verify `wrapper.owner() == token.defaultAdmin()`. The contracts do not
      enforce this coupling, but it is the recommended state — divergence
      enables partial privilege escalation. Set up an off-chain monitor for
      the inverted condition.

## Phase 10: Frontend and Ops Update

- [ ] Update frontend configuration with the deployed proxy addresses.
- [ ] Confirm the UI points at the AJUN foreign-asset precompile address, not a mock token.
- [ ] Update operational runbooks with proxy addresses, tx hashes, and multisig ownership status.
- [ ] Store final addresses somewhere durable.

## Phase 10B: Install Timelock (BEFORE Phase 11)

The wrapper has no timelock at deploy time — that's deliberate. While
the allowlist gate is on (Phases 4–10), only the deployer + designated
testers can interact, so a fast multisig owner is the right choice for
iterating on issues. **Before flipping the gate off** (Phase 11), the
multisig must hand ownership to a `TimelockController` so any
subsequent admin action (especially `upgradeToAndCall`) is delayed,
giving public users an exit window. See `audit/REPORT.md` recommendation
INFO-B and `docs/SECURITY.md` "Production Hardening Checklist".

### 10B.A — Deploy the timelock

- [ ] Decide on the timelock parameters:
  - **Min delay** (typical: 86400 = 24h; conservative: 172800 = 48h).
  - **Proposers** — the multisig (single address; can be a list).
    OZ grants `CANCELLER_ROLE` to each proposer automatically.
  - **Executors** — `address(0)` for "anyone can execute after delay"
    (standard public pattern), or a restricted list.
  - **Admin** — `address(0)` for an immutable timelock (cannot
    reconfigure delay or roles). Recommended for production.

- [ ] Deploy from a **separate** EOA (not the deployer, not the
      multisig — for clean separation):

```bash
PROPOSERS=0x<multisig> \
TIMELOCK_DELAY_SECS=86400 \
EXECUTORS=0x0000000000000000000000000000000000000000 \
ADMIN=0x0000000000000000000000000000000000000000 \
  npx hardhat run scripts/deploy_timelock.ts --network polkadotMainnet
```

- [ ] Record the deployed `TIMELOCK_ADDRESS`.

### 10B.B — Hand wrapper ownership to the timelock

- [ ] Multisig calls `wrapper.transferOwnership(timelock)` (single tx).

- [ ] Multisig schedules the timelock to call `wrapper.acceptOwnership()`:

```text
timelock.schedule(
  target:        wrapper,
  value:         0,
  data:          encodeCall(wrapper.acceptOwnership, ()),
  predecessor:   0x0,
  salt:          keccak256("acceptOwnership-wrapper-2026-MM-DD"),
  delay:         86400
)
```

- [ ] Wait the configured delay (24h for production).

- [ ] Anyone executes the scheduled call (open executor pattern):

```text
timelock.execute(target, 0, calldata, predecessor, salt)
```

- [ ] Verify `wrapper.owner() == <timelock_address>`.

### 10B.C — Hand ERC20 admin role to the timelock

- [ ] Multisig calls `token.beginDefaultAdminTransfer(timelock)`.

- [ ] Wait the ERC20's configured admin delay (production: 5 days).

- [ ] Multisig schedules the timelock to call
      `token.acceptDefaultAdminTransfer()`:

```text
timelock.schedule(
  target:        token,
  value:         0,
  data:          encodeCall(token.acceptDefaultAdminTransfer, ()),
  predecessor:   0x0,
  salt:          keccak256("acceptAdmin-token-2026-MM-DD"),
  delay:         86400
)
```

- [ ] Wait the timelock delay (24h). Anyone executes.

- [ ] Verify `token.defaultAdmin() == <timelock_address>`.

- [ ] **Cross-check**: `wrapper.owner() == token.defaultAdmin() == timelock` (per audit ATS-04).

> **Total wall-clock for Phase 10B**: ~5–6 days for the ERC20 admin
> transfer + however long you set the timelock's own delay. Plan
> announcements accordingly.

## Phase 11: Open To Public

Only execute once all prior phases are green AND the timelock is in
place AND the multisig is comfortable.

- [ ] **PREREQUISITE**: verify `wrapper.owner() == <timelock_address>`.
      If still the multisig, **stop** — go back to Phase 10B. Without
      the timelock, the multisig has unilateral instant-upgrade power
      over public user funds.
- [ ] **PREREQUISITE**: verify `token.defaultAdmin() == <timelock_address>`.
- [ ] Multisig schedules + executes `wrapper.setAllowlistEnabled(false)`
      via the timelock.
- [ ] Confirm event `AllowlistEnabledUpdated(false)` emitted in the tx receipt.
- [ ] Confirm an external (non-allowlisted) test account can now `deposit`.
- [ ] Announce.

If anything goes wrong post-launch, multisig can re-gate immediately
with `setAllowlistEnabled(true)` — but now via the timelock with the
configured delay (typically 24h). For per-account surgical blocks
(suspicious address), use `setAllowlist(target, false)` — also via the
timelock. The pause circuit breaker (`pause()`) likewise goes through
the timelock; for genuinely instant emergency response, the design
intention is the allowlist's per-account block, not pause.

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
