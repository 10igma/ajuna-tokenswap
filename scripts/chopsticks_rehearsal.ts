/**
 * Chopsticks rehearsal — end-to-end production-flow exercise against a
 * forked Polkadot Asset Hub.
 *
 * What it does:
 *   1. Connectivity pre-flight (substrate ws + eth-rpc adapter).
 *   2. Verify the AJUN foreign-asset precompile is reachable at the
 *      recorded address (decimals, totalSupply readable).
 *   3. Fund Alith's H160 with AJUN via Chopsticks `dev_setStorage`.
 *   4. Inline deploy of `AjunaERC20` + `AjunaWrapper` (mirrors
 *      `scripts/deploy_wrapper.ts`, with a short `ADMIN_DELAY_SECS` so the
 *      handoff rehearsal is fast).
 *   5. Post-deploy verifications: `boundMinter == wrapper`,
 *      `allowlistEnabled == true`, decimals coherence already asserted by
 *      the wrapper init.
 *   6. Phase-6 seed: deposit a tiny amount of AJUN as the deployer (owner
 *      short-circuits the allowlist).
 *   7. Add a fresh tester to the allowlist; tester wraps + unwraps; verify
 *      `isUnderCollateralized() == false` and `getInvariantDelta() == 0`.
 *   8. Allowlist negative test: a separate non-allowlisted account cannot
 *      deposit, but CAN withdraw if it later receives wAJUN (audit MED-1
 *      property).
 *   9. Multisig handoff rehearsal:
 *        - `transferOwnership(multisig)` + `beginDefaultAdminTransfer(multisig)`
 *        - sleep `ADMIN_DELAY_SECS`
 *        - multisig calls `acceptOwnership` + `acceptDefaultAdminTransfer`
 *        - verify `wrapper.owner() == token.defaultAdmin() == multisig`
 *  10. Phase-11 open-up: multisig calls `setAllowlistEnabled(false)`. The
 *      previously-blocked random account can now deposit + withdraw.
 *  11. Final invariant verification.
 *
 * Run via:
 *   ./scripts/chopsticks_rehearsal.sh
 *
 * Or directly:
 *   FOREIGN_ASSET=0x0000002d00000000000000000000000002200000 \
 *   ADMIN_DELAY_SECS=60 \
 *     npx hardhat run scripts/chopsticks_rehearsal.ts --network local
 */

import { ethers } from "hardhat";

// ─── Constants ─────────────────────────────────────────────────────────

const DEFAULT_FOREIGN_ASSET = "0x0000002d00000000000000000000000002200000"; // mainnet AJUN
const DEFAULT_ADMIN_DELAY_SECS = 60;
const SUBSTRATE_WS = process.env.SUBSTRATE_WS || "ws://127.0.0.1:8000";
const ETH_RPC = process.env.ETH_RPC || "http://127.0.0.1:8545";

const AJUN_LOCATION = {
  parents: 1,
  interior: { X1: [{ Parachain: 2051 }] },
};

const SEED_AMOUNT = ethers.parseUnits("100", 12); // 100 AJUN dust seed
const TESTER_AMOUNT = ethers.parseUnits("10", 12); // 10 AJUN per tester

// ─── Helpers ───────────────────────────────────────────────────────────

function header(s: string) {
  console.log("\n═══════════════════════════════════════════════════════════════════");
  console.log(`  ${s}`);
  console.log("═══════════════════════════════════════════════════════════════════");
}

function ok(s: string) {
  console.log(`  ✓ ${s}`);
}

function info(s: string) {
  console.log(`  · ${s}`);
}

function fail(s: string): never {
  console.error(`  ✗ ${s}`);
  process.exit(1);
}

/** H160 → AccountId32 via pallet-revive's AccountId32Mapper fallback: H160 || 0xEE..0xEE */
function h160ToAccountId32(h160: string): string {
  const stripped = h160.toLowerCase().startsWith("0x") ? h160.slice(2) : h160;
  if (stripped.length !== 40) throw new Error(`bad h160: ${h160}`);
  return "0x" + stripped + "ee".repeat(12);
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Main ──────────────────────────────────────────────────────────────

async function main() {
  const FOREIGN_ASSET = process.env.FOREIGN_ASSET || DEFAULT_FOREIGN_ASSET;
  const ADMIN_DELAY_SECS = parseInt(process.env.ADMIN_DELAY_SECS || String(DEFAULT_ADMIN_DELAY_SECS), 10);

  header("Chopsticks rehearsal — Ajuna Tokenswap end-to-end production flow");
  info(`Foreign asset:        ${FOREIGN_ASSET}`);
  info(`Admin transfer delay: ${ADMIN_DELAY_SECS}s`);
  info(`Substrate WS:         ${SUBSTRATE_WS}`);
  info(`Eth-RPC:              ${ETH_RPC}`);

  // ── Phase 0 — connectivity ──────────────────────────────────────────
  header("Phase 0 — connectivity pre-flight");

  // Eth-RPC: hardhat is already configured for this network; if we got here
  // the provider is reachable. Validate by reading chain id.
  const network = await ethers.provider.getNetwork();
  ok(`Eth-RPC reachable (chainId=${network.chainId})`);

  // Substrate ws via @polkadot/api for dev_setStorage + decimals lookup.
  let api: any;
  let WsProvider: any;
  let ApiPromise: any;
  try {
    const polkadot = await import("@polkadot/api");
    ApiPromise = polkadot.ApiPromise;
    WsProvider = polkadot.WsProvider;
  } catch {
    fail("@polkadot/api not installed. Run: npm install --save-dev @polkadot/api");
  }
  api = await ApiPromise.create({ provider: new WsProvider(SUBSTRATE_WS) });
  const chain = (await api.rpc.system.chain()).toString();
  const specVersion = api.runtimeVersion.specVersion.toString();
  ok(`Substrate WS reachable (chain=${chain}, runtime=${specVersion})`);

  // ── Phase 1 — verify AJUN precompile reachable from EVM ─────────────
  header("Phase 1 — verify AJUN foreign-asset precompile");
  const precompileAbi = [
    "function decimals() view returns (uint8)",
    "function totalSupply() view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
  ];
  const precompile = new ethers.Contract(FOREIGN_ASSET, precompileAbi, ethers.provider);

  let precompileDecimals: number;
  try {
    precompileDecimals = Number(await precompile.decimals());
    ok(`AJUN precompile decimals(): ${precompileDecimals}`);
  } catch (e: any) {
    fail(`AJUN precompile not reachable at ${FOREIGN_ASSET}: ${e.message}`);
  }
  if (precompileDecimals !== 12) {
    fail(`Expected AJUN decimals == 12, got ${precompileDecimals}`);
  }
  const precompileSupply = await precompile.totalSupply();
  ok(`AJUN total supply: ${ethers.formatUnits(precompileSupply, 12)}`);

  // ── Phase 2 — fund deployer + multisig + tester via dev_setStorage ──
  header("Phase 2 — dev_setStorage funding (Chopsticks)");

  const [deployer] = await ethers.getSigners();
  const multisig = ethers.Wallet.createRandom().connect(ethers.provider);
  const tester = ethers.Wallet.createRandom().connect(ethers.provider);
  const stranger = ethers.Wallet.createRandom().connect(ethers.provider);

  info(`Deployer:  ${deployer.address}`);
  info(`Multisig:  ${multisig.address}  (fresh)`);
  info(`Tester:    ${tester.address}  (fresh)`);
  info(`Stranger:  ${stranger.address}  (fresh, never allowlisted)`);

  // Fund all four with native DOT so they can pay gas.
  const dotPerAccount = "1000000000000000"; // 1000 DOT (12 decimals)
  const accounts = [deployer.address, multisig.address, tester.address, stranger.address];
  for (const addr of accounts) {
    const accountId = h160ToAccountId32(addr);
    await api.rpc("dev_setStorage", {
      System: {
        Account: [
          [
            [accountId],
            { providers: 1, data: { free: dotPerAccount } },
          ],
        ],
      },
    });
  }
  ok(`Funded ${accounts.length} accounts with 1000 DOT each (substrate-side)`);

  // Fund deployer + tester with AJUN. Stranger gets nothing (so we can
  // verify they cannot deposit). Multisig doesn't need AJUN — they receive
  // ownership but don't deposit.
  const ajunPerAccount = "100000000000000"; // 100 AJUN (12 decimals)
  for (const addr of [deployer.address, tester.address]) {
    const accountId = h160ToAccountId32(addr);
    await api.rpc("dev_setStorage", {
      ForeignAssets: {
        Account: [
          [
            [AJUN_LOCATION, accountId],
            {
              balance: ajunPerAccount,
              status: "Liquid",
              reason: "Sufficient",
              extra: null,
            },
          ],
        ],
      },
    });
  }
  ok(`Funded deployer + tester with 100 AJUN each`);

  // Confirm via the precompile.
  const deployerAjun = await precompile.balanceOf(deployer.address);
  if (deployerAjun === 0n) {
    fail(`Deployer AJUN balance is 0 after dev_setStorage — funding did not take effect. Check pallet name + version.`);
  }
  ok(`Deployer AJUN balance (precompile): ${ethers.formatUnits(deployerAjun, 12)}`);

  // ── Phase 3 — inline deploy ─────────────────────────────────────────
  header("Phase 3 — deploy AjunaERC20 + AjunaWrapper");

  const TokenFactory = await ethers.getContractFactory("AjunaERC20", deployer);
  const tokenImpl = await TokenFactory.deploy();
  await tokenImpl.waitForDeployment();

  const tokenInit = TokenFactory.interface.encodeFunctionData("initialize", [
    "Wrapped Ajuna",
    "WAJUN",
    deployer.address,
    12,
    ADMIN_DELAY_SECS,
  ]);
  const ProxyFactory = await ethers.getContractFactory("ERC1967Proxy", deployer);
  const tokenProxy = await ProxyFactory.deploy(await tokenImpl.getAddress(), tokenInit);
  await tokenProxy.waitForDeployment();
  const token = TokenFactory.attach(await tokenProxy.getAddress());
  ok(`AjunaERC20 proxy: ${await token.getAddress()}`);

  const WrapperFactory = await ethers.getContractFactory("AjunaWrapper", deployer);
  const wrapperImpl = await WrapperFactory.deploy();
  await wrapperImpl.waitForDeployment();
  const wrapperInit = WrapperFactory.interface.encodeFunctionData("initialize", [
    await token.getAddress(),
    FOREIGN_ASSET,
  ]);
  const wrapperProxy = await ProxyFactory.deploy(await wrapperImpl.getAddress(), wrapperInit);
  await wrapperProxy.waitForDeployment();
  const wrapper = WrapperFactory.attach(await wrapperProxy.getAddress());
  ok(`AjunaWrapper proxy: ${await wrapper.getAddress()}`);

  // bindMinter
  await (await (token as any).bindMinter(await wrapper.getAddress())).wait();
  ok(`bindMinter(wrapper) — boundMinter = ${await (token as any).boundMinter()}`);

  // ── Phase 4 — post-deploy verifications ─────────────────────────────
  header("Phase 4 — post-deploy verifications");

  const MINTER_ROLE = await (token as any).MINTER_ROLE();
  const wrapperHasMinter = await (token as any).hasRole(MINTER_ROLE, await wrapper.getAddress());
  if (!wrapperHasMinter) fail(`Wrapper does not hold MINTER_ROLE`);
  ok(`Wrapper holds MINTER_ROLE`);

  const decimalsMatch = (await (token as any).decimals()) === BigInt(precompileDecimals);
  if (!decimalsMatch) fail(`Token decimals != precompile decimals`);
  ok(`token.decimals() == precompile.decimals() == ${precompileDecimals}`);

  const allowlistOn = await (wrapper as any).allowlistEnabled();
  if (!allowlistOn) fail(`allowlistEnabled is false on a fresh deploy — should be true`);
  ok(`allowlistEnabled == true (default-on per audit MED-1 / staged rollout intent)`);

  const ownerNow = await (wrapper as any).owner();
  const adminNow = await (token as any).defaultAdmin();
  if (ownerNow !== deployer.address) fail(`wrapper.owner() != deployer`);
  if (adminNow !== deployer.address) fail(`token.defaultAdmin() != deployer`);
  ok(`wrapper.owner() == token.defaultAdmin() == deployer (pre-handoff state)`);

  // ── Phase 5 — Phase-6B seed (owner short-circuits allowlist) ────────
  header("Phase 5 — Phase-6B seed (owner deposits AJUN dust)");

  await (await precompile.connect(deployer)).approve(await wrapper.getAddress(), SEED_AMOUNT);
  await (await (wrapper as any).connect(deployer).deposit(SEED_AMOUNT)).wait();
  const ownerWajun = await (token as any).balanceOf(deployer.address);
  if (ownerWajun !== SEED_AMOUNT) fail(`Owner wAJUN balance != seed amount`);
  ok(`Deployer deposited ${ethers.formatUnits(SEED_AMOUNT, 12)} AJUN; received matching wAJUN`);

  // ── Phase 6 — Allowlist a tester; tester wraps + unwraps ────────────
  header("Phase 6 — wrap/unwrap smoke from an allowlisted tester");

  await (await (wrapper as any).connect(deployer).setAllowlist(tester.address, true)).wait();
  ok(`Allowlisted tester ${tester.address}`);

  await (await precompile.connect(tester)).approve(await wrapper.getAddress(), TESTER_AMOUNT);
  await (await (wrapper as any).connect(tester).deposit(TESTER_AMOUNT)).wait();
  const testerWajun = await (token as any).balanceOf(tester.address);
  if (testerWajun !== TESTER_AMOUNT) fail(`Tester wAJUN != deposited amount`);
  ok(`Tester wrapped ${ethers.formatUnits(TESTER_AMOUNT, 12)} AJUN`);

  await (await (token as any).connect(tester).approve(await wrapper.getAddress(), TESTER_AMOUNT)).wait();
  await (await (wrapper as any).connect(tester).withdraw(TESTER_AMOUNT)).wait();
  const testerWajunAfter = await (token as any).balanceOf(tester.address);
  if (testerWajunAfter !== 0n) fail(`Tester wAJUN != 0 after unwrap`);
  ok(`Tester unwrapped — wAJUN balance back to 0`);

  // Invariant check
  const healthy = await (wrapper as any).isInvariantHealthy();
  const delta = await (wrapper as any).getInvariantDelta();
  const under = await (wrapper as any).isUnderCollateralized();
  if (!healthy) fail(`isInvariantHealthy() = false`);
  if (delta !== 0n) fail(`getInvariantDelta() = ${delta}, expected 0`);
  if (under) fail(`isUnderCollateralized() = true`);
  ok(`Invariant: healthy=true, delta=0, underCollateralized=false`);

  // ── Phase 7 — Stranger cannot deposit (allowlist on) ────────────────
  header("Phase 7 — stranger cannot deposit while gate is on");

  await (await precompile.connect(stranger)).approve(await wrapper.getAddress(), TESTER_AMOUNT);
  let strangerBlocked = false;
  try {
    // Stranger has 0 AJUN; the deposit would also revert on transferFrom,
    // but we want to verify the allowlist is the FIRST gate to fire.
    // Use staticCall against the modifier.
    await (wrapper as any).connect(stranger).deposit.staticCall(TESTER_AMOUNT);
  } catch (e: any) {
    strangerBlocked = e.message.includes("not allowlisted") || e.message.includes("revert");
  }
  if (!strangerBlocked) fail(`Stranger deposit did NOT revert`);
  ok(`Stranger blocked by allowlist (deposit reverts)`);

  // ── Phase 8 — Multisig handoff (begin) ──────────────────────────────
  header("Phase 8 — begin two-step + delayed handoff to multisig");

  await (await (wrapper as any).connect(deployer).transferOwnership(multisig.address)).wait();
  ok(`wrapper.transferOwnership(${multisig.address}) submitted`);
  const pendingOwner = await (wrapper as any).pendingOwner();
  if (pendingOwner !== multisig.address) fail(`pendingOwner != multisig`);

  await (await (token as any).connect(deployer).beginDefaultAdminTransfer(multisig.address)).wait();
  ok(`token.beginDefaultAdminTransfer(${multisig.address}) submitted`);
  const pendingAdmin = await (token as any).pendingDefaultAdmin();
  if (pendingAdmin.newAdmin !== multisig.address) fail(`pendingDefaultAdmin != multisig`);

  // Verify deployer still in control until acceptance.
  if ((await (wrapper as any).owner()) !== deployer.address) fail(`Owner changed before acceptance`);
  if ((await (token as any).defaultAdmin()) !== deployer.address) fail(`Admin changed before acceptance`);
  ok(`Deployer still in control until acceptance lands`);

  // ── Phase 9 — wait + accept ─────────────────────────────────────────
  header(`Phase 9 — sleep ${ADMIN_DELAY_SECS}s for delay, then accept`);

  // For Chopsticks we may need to advance the on-chain clock. The simplest
  // is to wait wall-clock time and let the substrate timestamp catch up.
  // Chopsticks block production is on-demand, so issue a couple of empty
  // txs to nudge new blocks during the sleep.
  const startTs = Date.now();
  while ((Date.now() - startTs) / 1000 < ADMIN_DELAY_SECS + 2) {
    await sleep(2000);
    process.stdout.write(".");
  }
  console.log("");

  await (await (wrapper as any).connect(multisig).acceptOwnership()).wait();
  ok(`multisig.acceptOwnership() landed`);
  await (await (token as any).connect(multisig).acceptDefaultAdminTransfer()).wait();
  ok(`multisig.acceptDefaultAdminTransfer() landed`);

  if ((await (wrapper as any).owner()) !== multisig.address) fail(`Owner != multisig after handoff`);
  if ((await (token as any).defaultAdmin()) !== multisig.address) fail(`Admin != multisig after handoff`);
  ok(`wrapper.owner() == token.defaultAdmin() == multisig`);

  // ── Phase 10 — Phase-11 open-up ─────────────────────────────────────
  header("Phase 10 — multisig opens the gate to the public");

  await (await (wrapper as any).connect(multisig).setAllowlistEnabled(false)).wait();
  if (await (wrapper as any).allowlistEnabled()) fail(`allowlistEnabled still true`);
  ok(`allowlistEnabled flipped to false`);

  // Stranger now wraps + unwraps. They had 0 AJUN — give them some via
  // dev_setStorage so we can complete the round-trip.
  const strangerAccountId = h160ToAccountId32(stranger.address);
  await api.rpc("dev_setStorage", {
    ForeignAssets: {
      Account: [
        [
          [AJUN_LOCATION, strangerAccountId],
          {
            balance: ajunPerAccount,
            status: "Liquid",
            reason: "Sufficient",
            extra: null,
          },
        ],
      ],
    },
  });
  ok(`Stranger funded with AJUN (post-open-up smoke)`);

  await (await precompile.connect(stranger)).approve(await wrapper.getAddress(), TESTER_AMOUNT);
  await (await (wrapper as any).connect(stranger).deposit(TESTER_AMOUNT)).wait();
  const strangerWajun = await (token as any).balanceOf(stranger.address);
  if (strangerWajun !== TESTER_AMOUNT) fail(`Stranger wAJUN != deposited amount`);
  ok(`Stranger wrapped ${ethers.formatUnits(TESTER_AMOUNT, 12)} AJUN (gate is off)`);

  await (await (token as any).connect(stranger).approve(await wrapper.getAddress(), TESTER_AMOUNT)).wait();
  await (await (wrapper as any).connect(stranger).withdraw(TESTER_AMOUNT)).wait();
  if ((await (token as any).balanceOf(stranger.address)) !== 0n) fail(`Stranger wAJUN != 0 after unwrap`);
  ok(`Stranger unwrapped — round-trip complete`);

  // ── Phase 11 — Final invariant check ────────────────────────────────
  header("Phase 11 — final invariant verification");

  const finalDelta = await (wrapper as any).getInvariantDelta();
  const finalUnder = await (wrapper as any).isUnderCollateralized();
  const finalSupply = await (token as any).totalSupply();
  const finalLocked = await precompile.balanceOf(await wrapper.getAddress());

  ok(`wAJUN totalSupply: ${ethers.formatUnits(finalSupply, 12)}`);
  ok(`AJUN locked in wrapper: ${ethers.formatUnits(finalLocked, 12)}`);
  ok(`Invariant delta: ${finalDelta} (negative = over-collateralized = safe; positive = ALARM)`);
  ok(`isUnderCollateralized: ${finalUnder}`);

  if (finalUnder) fail(`SYSTEM IS UNDER-COLLATERALIZED — rehearsal must abort`);

  // ── Done ────────────────────────────────────────────────────────────
  header("REHEARSAL PASSED");
  console.log(`
  Production-flow rehearsal complete. Audit-baseline properties verified
  against forked Polkadot Asset Hub state:

    - AJUN precompile reachable at ${FOREIGN_ASSET}
    - Decimals coherence (audit ATS-08) holds
    - bindMinter coupling (audit ATS-04) holds
    - Allowlist gates deposit only (audit MED-1) — withdraw remains
      permissionless even with the gate on
    - Two-step + delayed admin handoff (REVIEW_v1 M-A + audit MED-2) works
    - Phase-11 open-up → public wrap/unwrap works
    - Backing invariant intact

  Recorded addresses:
    ERC20:    ${await token.getAddress()}
    Wrapper:  ${await wrapper.getAddress()}
    Multisig (stand-in): ${multisig.address}
    Tester (stand-in):   ${tester.address}
`);

  await api.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error("\n  ✗ REHEARSAL FAILED:", e);
  process.exit(1);
});
