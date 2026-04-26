/**
 * Deploy a mock Foreign Asset (ERC20) for local dev-node E2E testing.
 *
 * The local revive-dev-node does NOT include pallet-assets, so there is no
 * real ERC20 precompile.  This script deploys an AjunaERC20 instance (behind
 * a UUPS proxy) that acts as a stand-in for the foreign asset precompile.
 * It then mints a configurable amount to the test account so that the full
 * wrap/unwrap flow can be exercised.
 *
 * Usage:
 *   npx hardhat run scripts/deploy_mock_foreign_asset.ts --network local
 *
 * After running, note the printed address and paste it into
 *   - deployments.config.ts  → local.foreignAssetAddress
 *   - app.html               → CONFIG.FOREIGN_ADDRESS  (or URL param)
 *   - FOREIGN_ASSET env var  → for the deploy_wrapper.ts script
 */

import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  // ── Deploy a mock "Foreign Asset" (AjunaERC20 behind UUPS proxy) ──────
  const AjunaERC20 = await ethers.getContractFactory("AjunaERC20");

  // 1. Deploy implementation
  const impl = await AjunaERC20.deploy();
  await impl.waitForDeployment();

  // 2. Deploy ERC1967Proxy with initialize() calldata
  const initData = AjunaERC20.interface.encodeFunctionData("initialize", [
    "Mock AJUN Foreign Asset",
    "AJUN",
    deployer.address, // admin
    12,               // decimals — must match production AJUN
    0,                // initialAdminDelay — instant for the local mock
  ]);
  const ProxyFactory = await ethers.getContractFactory("ERC1967Proxy");
  const proxy = await ProxyFactory.deploy(await impl.getAddress(), initData);
  await proxy.waitForDeployment();

  const mockFA = AjunaERC20.attach(await proxy.getAddress());
  const mockFAAddress = await mockFA.getAddress();
  console.log("Mock Foreign Asset (proxy) deployed at:", mockFAAddress);

  // Grant MINTER_ROLE to deployer so we can mint freely
  const MINTER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("MINTER_ROLE"));
  const grantTx = await mockFA.grantRole(MINTER_ROLE, deployer.address);
  await grantTx.wait();
  console.log("MINTER_ROLE granted to deployer");

  // ── Mint tokens to accounts ────────────────────────────────────────────
  const mintAmount = ethers.parseUnits("10000", 12); // 10,000 AJUN

  // Mint to deployer (Alith, the pre-funded dev account)
  const mintTx = await mockFA.mint(deployer.address, mintAmount);
  await mintTx.wait();
  console.log(
    `Minted ${ethers.formatUnits(mintAmount, 12)} mock AJUN to deployer ${deployer.address}`
  );

  // Also mint to Baltathar (2nd dev account) for multi-user testing
  const baltatharAddr = "0x3Cd0A705a2DC65e5b1E1205896BaA2be8A07c6e0";
  const mintTx2 = await mockFA.mint(baltatharAddr, mintAmount);
  await mintTx2.wait();
  console.log(
    `Minted ${ethers.formatUnits(mintAmount, 12)} mock AJUN to Baltathar ${baltatharAddr}`
  );

  // ── Summary ───────────────────────────────────────────────────────────
  console.log("\n════════════════════════════════════════════");
  console.log("  Mock Foreign Asset Setup Complete");
  console.log("════════════════════════════════════════════");
  console.log(`  Address:  ${mockFAAddress}`);
  console.log(`  Symbol:   AJUN (mock)`);
  console.log(`  Decimals: 12`);
  console.log(`  Minted:   10,000 AJUN to test account + deployer`);
  console.log("");
  console.log("  Next steps:");
  console.log(`    1. Deploy AjunaWrapper with this foreign asset address:`);
  console.log(
    `       FOREIGN_ASSET=${mockFAAddress} npx hardhat run scripts/deploy_wrapper.ts --network local`
  );
  console.log(`    2. Run E2E test:`);
  console.log(
    `       FOREIGN_ASSET=${mockFAAddress} npx hardhat run scripts/e2e_test.ts --network local`
  );
  console.log(
    `    3. Open the dApp:`
  );
  console.log(
    `       http://localhost:8000/app.html?foreign=${mockFAAddress}&wrapper=<WRAPPER>&erc20=<ERC20>`
  );
  console.log("════════════════════════════════════════════\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
