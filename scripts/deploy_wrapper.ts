/**
 * Deploy AjunaWrapper system via UUPS proxies (ERC20 + Wrapper + grant MINTER_ROLE).
 *
 * This is a plain Hardhat script that takes the foreign asset address via
 * environment variable — simpler for the E2E pipeline.
 *
 * Each contract is deployed as:
 *   1. Implementation contract (logic only, no state)
 *   2. ERC1967Proxy pointing to the implementation, with initialize() calldata
 *
 * Env vars:
 *   FOREIGN_ASSET    — Foreign asset address (required)
 *   DECIMALS         — Token decimals (default: 12)
 *   ADMIN_DELAY_SECS — Two-step DEFAULT_ADMIN_ROLE transfer delay in seconds.
 *                      Default: 432000 (5 days). Use 0 for tests / fast
 *                      Chopsticks rehearsals.
 *
 * Usage:
 *   FOREIGN_ASSET=0x... npx hardhat run scripts/deploy_wrapper.ts --network local
 */

import { ethers } from "hardhat";

async function deployProxy(
  implFactory: any,
  initArgs: any[],
  initFunction: string = "initialize"
): Promise<any> {
  // 1. Deploy implementation
  const impl = await implFactory.deploy();
  await impl.waitForDeployment();
  const implAddr = await impl.getAddress();

  // 2. Encode initialize() calldata
  const initData = implFactory.interface.encodeFunctionData(initFunction, initArgs);

  // 3. Deploy ERC1967Proxy
  const ProxyFactory = await ethers.getContractFactory("ERC1967Proxy");
  const proxy = await ProxyFactory.deploy(implAddr, initData);
  await proxy.waitForDeployment();
  const proxyAddr = await proxy.getAddress();

  // 4. Return typed contract attached to proxy address
  return implFactory.attach(proxyAddr);
}

async function main() {
  const foreignAssetAddress = process.env.FOREIGN_ASSET;
  if (!foreignAssetAddress) {
    throw new Error("FOREIGN_ASSET env variable is required");
  }

  const decimals = parseInt(process.env.DECIMALS || "12", 10);
  const adminDelaySecs = parseInt(process.env.ADMIN_DELAY_SECS || "432000", 10); // 5 days
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("Foreign Asset:", foreignAssetAddress);
  console.log("Decimals:", decimals);
  console.log("Default-admin transfer delay:", adminDelaySecs, "seconds");

  // 1. Deploy AjunaERC20 (behind UUPS proxy)
  const TokenFactory = await ethers.getContractFactory("AjunaERC20");
  const token = await deployProxy(TokenFactory, [
    "Wrapped Ajuna",
    "WAJUN",
    deployer.address,
    decimals,
    adminDelaySecs,
  ]);
  const tokenAddr = await token.getAddress();
  console.log("AjunaERC20 proxy deployed at:", tokenAddr);

  // 2. Deploy AjunaWrapper (behind UUPS proxy)
  const WrapperFactory = await ethers.getContractFactory("AjunaWrapper");
  const wrapper = await deployProxy(WrapperFactory, [tokenAddr, foreignAssetAddress]);
  const wrapperAddr = await wrapper.getAddress();
  console.log("AjunaWrapper proxy deployed at:", wrapperAddr);

  // 3. Bind MINTER_ROLE to the wrapper (one-shot). bindMinter atomically
  //    sets `boundMinter = wrapper` and grants MINTER_ROLE; subsequent
  //    `grantRole(MINTER_ROLE, X)` calls revert unless X == wrapper.
  //    Closes audit ATS-04: prevents an ERC20 admin from minting unbacked
  //    wAJUN even if `wrapper.owner()` and `token.defaultAdmin()` diverge.
  const bindTx = await token.bindMinter(wrapperAddr);
  await bindTx.wait();
  console.log("MINTER_ROLE bound to Wrapper (boundMinter set)");

  // Print summary for downstream scripts to parse
  console.log("\n═══ DEPLOYED (UUPS Proxies) ═══");
  console.log(`ERC20_ADDRESS=${tokenAddr}`);
  console.log(`WRAPPER_ADDRESS=${wrapperAddr}`);
  console.log(`FOREIGN_ASSET=${foreignAssetAddress}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
