/**
 * Deploy a `TimelockController` to gate wrapper / ERC20 admin actions.
 *
 * The team's design model (per docs/PRODUCTION-CHECKLIST.md):
 *
 *   1. Deploy contracts. Allowlist gate ON.
 *   2. Multisig handoff (Phase 8/9). Iterate freely on issues.
 *   3. When stable, run THIS script. Then transfer
 *      `wrapper.owner()` and `token.defaultAdmin()` to the timelock.
 *   4. THEN flip `setAllowlistEnabled(false)` (Phase 11). Public open.
 *
 * Until step 3, the contract has multisig-only owner — fast pause /
 * rescue / upgrade. After step 3, every owner action is delayed by the
 * timelock's `minDelay` (default 24h), giving users an exit window for
 * any malicious upgrade. See `audit/REPORT.md` recommendation INFO-B.
 *
 * Env vars:
 *   TIMELOCK_DELAY_SECS   Minimum delay between schedule and execute.
 *                         Default: 86400 (24h). Audit-recommended floor.
 *                         Use a longer value (48h, 72h) for more
 *                         conservative governance.
 *   PROPOSERS             Comma-separated H160 addresses with PROPOSER_ROLE
 *                         (and CANCELLER_ROLE — OZ grants both together).
 *                         Typically: the multisig.
 *   EXECUTORS             Comma-separated H160 addresses with EXECUTOR_ROLE.
 *                         Use the literal `0x0000000000000000000000000000000000000000`
 *                         for "anyone can execute" — the standard public
 *                         pattern; cheaper to operate than restricted
 *                         executors. Default: address(0).
 *   ADMIN                 DEFAULT_ADMIN_ROLE on the timelock itself.
 *                         The conservative production value is
 *                         `address(0)` — the timelock becomes immutable
 *                         (cannot reconfigure delay / roles). Default:
 *                         address(0).
 *
 * Usage:
 *   PROPOSERS=0xMULTISIG_ADDRESS \
 *     npx hardhat run scripts/deploy_timelock.ts --network polkadotMainnet
 *
 *   # All defaults except proposers:
 *   PROPOSERS=0xMULTISIG \
 *   EXECUTORS=0x0000000000000000000000000000000000000000 \
 *   ADMIN=0x0000000000000000000000000000000000000000 \
 *   TIMELOCK_DELAY_SECS=86400 \
 *     npx hardhat run scripts/deploy_timelock.ts --network polkadotMainnet
 *
 * After this script runs, follow PRODUCTION-CHECKLIST.md Phase 10B for
 * the actual ownership handover. THE OWNERSHIP HANDOVER IS NOT
 * AUTOMATED — that's deliberate (it's a multi-day, multi-tx operation
 * with strong "do not skip" semantics).
 */

import { ethers } from "hardhat";

const ZERO = "0x0000000000000000000000000000000000000000";

function parseAddressList(env: string | undefined, defaultList: string[]): string[] {
  if (!env || env.trim() === "") return defaultList;
  const list = env
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const a of list) {
    if (!ethers.isAddress(a)) {
      throw new Error(`Invalid address in env list: ${a}`);
    }
  }
  return list;
}

async function main() {
  const delaySecs = parseInt(process.env.TIMELOCK_DELAY_SECS || "86400", 10);

  const proposers = parseAddressList(process.env.PROPOSERS, []);
  if (proposers.length === 0) {
    throw new Error(
      "PROPOSERS env var is required (comma-separated H160 addresses; typically the multisig)"
    );
  }

  const executors = parseAddressList(process.env.EXECUTORS, [ZERO]);
  const admin = process.env.ADMIN ? process.env.ADMIN.trim() : ZERO;
  if (!ethers.isAddress(admin)) {
    throw new Error(`Invalid ADMIN address: ${admin}`);
  }

  const [deployer] = await ethers.getSigners();

  console.log("═══ TimelockController deployment ═══");
  console.log(`  Deployer:           ${deployer.address}`);
  console.log(`  Min delay:          ${delaySecs} seconds (${delaySecs / 3600}h)`);
  console.log(`  Proposers:          ${proposers.join(", ")}`);
  console.log(`    (each also gets CANCELLER_ROLE — OZ grants both together)`);
  console.log(`  Executors:          ${executors.join(", ")}`);
  if (executors.length === 1 && executors[0] === ZERO) {
    console.log(`    (open executor — anyone can execute after delay)`);
  }
  console.log(`  Admin:              ${admin}`);
  if (admin === ZERO) {
    console.log(`    (immutable — timelock cannot reconfigure roles or delay)`);
  } else {
    console.log(`    (mutable — ${admin} can reconfigure roles and delay)`);
  }
  console.log("");

  const TimelockFactory = await ethers.getContractFactory("TimelockController");
  const timelock = await TimelockFactory.deploy(delaySecs, proposers, executors, admin);
  await timelock.waitForDeployment();
  const timelockAddr = await timelock.getAddress();

  console.log("✓ TimelockController deployed");
  console.log(`  Address: ${timelockAddr}`);
  console.log("");

  // Sanity verifications.
  const PROPOSER_ROLE = await (timelock as any).PROPOSER_ROLE();
  const EXECUTOR_ROLE = await (timelock as any).EXECUTOR_ROLE();
  const CANCELLER_ROLE = await (timelock as any).CANCELLER_ROLE();
  const minDelay = await (timelock as any).getMinDelay();

  console.log("Verifying roles:");
  for (const p of proposers) {
    const hasProp = await (timelock as any).hasRole(PROPOSER_ROLE, p);
    const hasCancel = await (timelock as any).hasRole(CANCELLER_ROLE, p);
    console.log(`  ${p}  PROPOSER=${hasProp}  CANCELLER=${hasCancel}`);
  }
  for (const e of executors) {
    const hasExec = await (timelock as any).hasRole(EXECUTOR_ROLE, e);
    console.log(`  ${e}  EXECUTOR=${hasExec}`);
  }
  console.log(`  getMinDelay() = ${minDelay}`);
  console.log("");

  console.log("═══ NEXT STEPS (NOT automated by this script) ═══");
  console.log("");
  console.log("Per docs/PRODUCTION-CHECKLIST.md Phase 10B, the multisig now");
  console.log("performs the ownership handover. This is multi-day and is");
  console.log("intentionally manual — review each tx carefully:");
  console.log("");
  console.log("  1. wrapper.transferOwnership(timelock)             — single tx");
  console.log("     wrapper.acceptOwnership() via timelock          — schedule + wait + execute");
  console.log("");
  console.log("  2. token.beginDefaultAdminTransfer(timelock)       — single tx");
  console.log("     (wait the configured ERC20 admin delay, default 5 days)");
  console.log("     token.acceptDefaultAdminTransfer() via timelock — schedule + wait + execute");
  console.log("");
  console.log("After both handovers complete, verify:");
  console.log(`  wrapper.owner()      == ${timelockAddr}`);
  console.log(`  token.defaultAdmin() == ${timelockAddr}`);
  console.log("");
  console.log("Only then is it safe to run setAllowlistEnabled(false) — Phase 11.");
  console.log("");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`TIMELOCK_ADDRESS=${timelockAddr}`);
}

main().catch((e) => {
  console.error("\n✗ TimelockController deployment failed:", e);
  process.exit(1);
});
