# AI Handoff

This file is for any AI agent joining the Ajuna Tokenswap project mid-stream. It is intended to provide enough context to work productively without re-reading the entire repository first.

If the task involves production deployment, production verification, or post-deployment operations, read `docs/PRODUCTION-CHECKLIST.md` first and treat it as the rollout source of truth.

## Project Purpose

Ajuna Tokenswap is a smart-contract system that wraps AJUN on Polkadot Asset Hub into a standard ERC20 token named wAJUN.

Core flow:
- User deposits AJUN foreign-asset tokens into the wrapper treasury.
- The wrapper locks AJUN and mints the same amount of wAJUN.
- User later burns wAJUN to withdraw the locked AJUN.

This is a mint-and-lock design. The intended invariant is:

`wAJUN.totalSupply() == AJUN.balanceOf(wrapper)`

## Current Status

As of 2026-04-26, production Polkadot Asset Hub is ready for AJUN wrapping.

Verified live state:
- Chain: Polkadot Asset Hub
- Runtime version: `2002001`
- `assetsPrecompiles` pallet: live on production
- AJUN foreign asset: registered
- AJUN foreign-asset precompile index: `45`
- AJUN foreign-asset precompile address: `0x0000002d00000000000000000000000002200000`

Practical consequence:
- The project no longer depends on the old ForeignAssetIdExtractor blocker.
- Production deployment can use `FOREIGN_ASSET=0x0000002d00000000000000000000000002200000`.

## What This Repo Contains

Main implementation:
- `contracts/AjunaERC20.sol`: wrapped token contract, UUPS upgradeable, role-gated mint and burn.
- `contracts/AjunaWrapper.sol`: treasury contract, UUPS upgradeable, holds AJUN and mints/burns wAJUN.
- `contracts/interfaces/IERC20Precompile.sol`: minimal ERC20-compatible interface used for the AJUN precompile.
- `contracts/Proxy.sol`: exposes OpenZeppelin `ERC1967Proxy` for deployment.

Deployment and config:
- `scripts/deploy_wrapper.ts`: main deploy path for ERC20 proxy, wrapper proxy, and role grant.
- `scripts/deploy_production.sh`: production deploy helper with checks and prompts.
- `scripts/lookup_ajun_asset.ts`: on-chain discovery of AJUN registration, precompile index, and address.
- `deployments.config.ts`: environment definitions and deterministic precompile address computation.
- `hardhat.config.ts`: Hardhat network configuration for local, testnet, and mainnet.
- `ignition/modules/AjunaWrapper.ts`: optional Ignition-based deployment module.

Testing and simulation:
- `test/wrapper.test.ts`: comprehensive test suite, currently 61 tests.
- `scripts/e2e_test.ts`: end-to-end integration script.
- `scripts/e2e_local.sh`: local automated pipeline.
- `chopsticks.yml`: Asset Hub fork config for production-like testing.

Documentation:
- `README.md`: main entry point.
- `docs/ARCHITECTURE.md`: contract and proxy model.
- `docs/DEPLOYMENT.md`: deployment flows across environments.
- `docs/PRODUCTION-CHECKLIST.md`: operator and AI checklist for production rollout and post-deploy verification.
- `docs/SECURITY.md`, `docs/USAGE.md`, `docs/UPGRADE.md`, `docs/QUICKSTART.md`: supporting docs.

Large dependency tree:
- `polkadot-sdk/`: very large vendored checkout used for local node tooling and reference. Avoid broad scans here unless needed.

## Architecture Summary

### Contracts

`AjunaERC20`:
- Standard ERC20 behavior for wAJUN.
- UUPS upgradeable.
- Uses OpenZeppelin upgradeable contracts.
- Roles:
  - `DEFAULT_ADMIN_ROLE`
  - `MINTER_ROLE`
  - `UPGRADER_ROLE`
- `mint()` and `burnFrom()` are restricted to `MINTER_ROLE`.

`AjunaWrapper`:
- Treasury contract that receives AJUN and issues wAJUN.
- UUPS upgradeable.
- `OwnableUpgradeable`, `PausableUpgradeable`, `ReentrancyGuardUpgradeable`.
- `deposit(amount)` transfers AJUN from user to wrapper, then mints wAJUN.
- `withdraw(amount)` burns wAJUN from user, then transfers AJUN back.

### Upgrade Pattern

Both main contracts are deployed behind `ERC1967Proxy` proxies.

Do not treat implementation addresses as user-facing deployment addresses. The proxy addresses are the real system addresses.

### Asset Model

The wrapper is designed to talk to any ERC20-compatible address. This was deliberate: it allowed the project to use a mock ERC20 locally before the real AJUN foreign-asset precompile existed on production.

No Solidity refactor was needed once Asset Hub exposed foreign-asset precompiles.

## Runtime and Precompile Model

AJUN on Asset Hub is a foreign asset keyed by this MultiLocation:

```json
{
  "parents": 1,
  "interior": {
    "X1": [
      {
        "Parachain": 2051
      }
    ]
  }
}
```

The `assetsPrecompiles` pallet assigns a sequential `u32` index to each foreign asset. The ERC20 precompile address is deterministic:

`[index (4 bytes big-endian)] [12 zero bytes] [prefix (2 bytes big-endian)] [0x0000]`

Known prefixes:
- Native assets: `0x0120`
- Foreign assets: `0x0220`
- Pool assets: `0x0320`

For AJUN on production:
- Index: `45`
- Address: `0x0000002d00000000000000000000000002200000`

The lookup script is the canonical way to verify this against live chain state.

## Networks

Hardhat networks currently configured:

| Network | Chain ID | Purpose |
| --- | --- | --- |
| `local` | `420420420` | local `revive-dev-node` or eth-rpc adapter |
| `polkadotTestnet` | `420420417` | Polkadot Hub TestNet |
| `polkadotMainnet` | `420420420` | Polkadot Asset Hub production |

RPCs of interest:
- Production WebSocket: `wss://polkadot-asset-hub-rpc.polkadot.io`
- Production EVM RPC: `https://polkadot-asset-hub-eth-rpc.polkadot.io`
- Westend Asset Hub WebSocket: `wss://westend-asset-hub-rpc.polkadot.io`

## Local Development Model

There are several distinct execution environments and they are not interchangeable.

### 1. Hardhat Unit Tests

Purpose:
- Validate contract logic quickly.

Command:

```bash
npm test
```

Behavior:
- Uses mock ERC20 contracts.
- Does not depend on real Asset Hub runtime behavior.

### 2. Local PVM Integration

Purpose:
- Test deploys against a local revive-compatible node.

Important limitation:
- The local `revive-dev-node` runtime does not expose real foreign-asset precompiles.
- For local testing, the project deploys a mock ERC20 as the stand-in foreign asset.

Useful commands:

```bash
./scripts/run_local_node.sh
npx hardhat run scripts/deploy_mock_foreign_asset.ts --network local
FOREIGN_ASSET=0x... npx hardhat run scripts/deploy_wrapper.ts --network local
./scripts/e2e_local.sh
```

### 3. Chopsticks Fork

Purpose:
- Test against forked real Asset Hub state.

Useful when:
- You need the real runtime, real asset registrations, and real precompile behavior without touching mainnet.

Typical flow:

```bash
npx @acala-network/chopsticks --config=chopsticks.yml
./polkadot-sdk/target/release/eth-rpc --node-rpc-url ws://127.0.0.1:8000
npx ts-node scripts/lookup_ajun_asset.ts ws://127.0.0.1:8000
```

### 4. Testnet

Purpose:
- Exercise the full path with the real precompile in a public environment.

Important note:
- AJUN must exist there as a registered foreign asset for the deployment flow to work as intended.

### 5. Production

Read `docs/PRODUCTION-CHECKLIST.md` before doing anything on mainnet.

Current production foreign asset address:

```bash
FOREIGN_ASSET=0x0000002d00000000000000000000000002200000
```

Primary deploy command:

```bash
FOREIGN_ASSET=0x0000002d00000000000000000000000002200000 npx hardhat run scripts/deploy_wrapper.ts --network polkadotMainnet
```

Alternate helper:

```bash
./scripts/deploy_production.sh
```

## Common Commands

Install:

```bash
npm install --legacy-peer-deps
```

Compile:

```bash
npx hardhat compile
```

Run tests:

```bash
npx hardhat test
```

Lookup AJUN on production:

```bash
npx ts-node scripts/lookup_ajun_asset.ts
```

Lookup AJUN on a custom endpoint:

```bash
npx ts-node scripts/lookup_ajun_asset.ts <ws_rpc_url>
```

Set production private key for Hardhat:

```bash
npx hardhat vars set PRIVATE_KEY
```

## Important Behaviors and Constraints

### 1. The wrapper depends on ERC20 compatibility, not runtime-specific ABI tricks

This is why local mocks and the real foreign-asset precompile share the same contract integration path.

### 2. `burnFrom()` requires allowance

Unwrap is not just a balance check. The wrapper burns from the user, so the user must approve the wrapper to spend wAJUN first.

### 3. The wrapper must hold `MINTER_ROLE`

Deploy flow is not complete until `AjunaWrapper` receives `MINTER_ROLE` on `AjunaERC20`.

### 4. Proxy initialization matters

Initialization is encoded into proxy deployment. If you bypass that or interact with implementations directly, you are using the system incorrectly.

### 5. Production uses the proxy addresses, not implementation addresses

Any frontend, scripts, or downstream tooling should target the proxies.

### 6. The runtime metadata shape can change

This already happened for `assetsPrecompiles.foreignAssetIdToAssetIndex`, which now needs tolerant decoding logic. `scripts/lookup_ajun_asset.ts` was updated to handle the current production return shape.

## Important Files to Read Before Major Changes

If an AI is about to change contracts or deployment logic, these are the fastest high-signal files:

1. `README.md`
2. `docs/ARCHITECTURE.md`
3. `docs/DEPLOYMENT.md`
4. `contracts/AjunaERC20.sol`
5. `contracts/AjunaWrapper.sol`
6. `scripts/deploy_wrapper.ts`
7. `scripts/lookup_ajun_asset.ts`
8. `test/wrapper.test.ts`

## Current Known Good Facts

These were verified during recent work and should be treated as the current baseline unless the chain changes again:

- AJUN is registered as a live foreign asset on production Asset Hub.
- Production runtime version observed: `2002001`.
- `assetsPrecompiles.nextAssetIndex()` reported `47` at time of verification.
- AJUN resolved to foreign-asset precompile index `45`.
- AJUN precompile address resolved to `0x0000002d00000000000000000000000002200000`.
- The reverse mapping from index `45` matched parachain `2051`.

## Recommended Workflow for Another AI

If your task is about code changes:
1. Read `README.md`, `docs/ARCHITECTURE.md`, and the touched source file.
2. Read `test/wrapper.test.ts` before changing contract behavior.
3. Make the smallest possible edit.
4. Run the narrowest validation that can falsify the change.

If your task is about production deployment:
1. Read `docs/PRODUCTION-CHECKLIST.md` first.
2. Re-run `npx ts-node scripts/lookup_ajun_asset.ts` to confirm the live precompile address.
3. Confirm the operator has set `PRIVATE_KEY` via Hardhat vars.
4. Deploy with `FOREIGN_ASSET=0x0000002d00000000000000000000000002200000`.
5. Record proxy addresses for frontend and operations.

If your task is about chain integration:
1. Prefer a Chopsticks fork before touching production.
2. Use production RPC metadata as ground truth, not stale docs.

## Things Not To Waste Time On

- Do not assume the local dev node has real Asset Hub precompiles.
- Do not assume the production blocker from older notes still exists.
- Do not scan the full `polkadot-sdk/` tree unless the task explicitly needs runtime internals.
- Do not treat implementation contracts as deployed system addresses.

## Likely Next Work Areas

The repository is already set up for deployment. The next realistic tasks are usually one of these:

- production deployment
- Chopsticks dry-run deployment with the live AJUN precompile address
- frontend wiring to real deployed proxy addresses
- operational checklist and multisig handoff
- post-deployment verification and smoke testing

## One-Line Summary

This repo is a UUPS-upgradeable AJUN-to-wAJUN wrapper for Polkadot Asset Hub, and as of 2026-04-26 the production AJUN foreign-asset precompile is live at `0x0000002d00000000000000000000000002200000`.
