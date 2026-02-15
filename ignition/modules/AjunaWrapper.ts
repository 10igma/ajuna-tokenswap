import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import { ethers } from "ethers";

const AjunaWrapperModule = buildModule("AjunaWrapperModule", (m) => {
  // Foreign Asset Precompile Address — must be set correctly for each target network.
  // Default: 0x...0801 (generic precompile). Override via ignition parameters for real deployments.
  const foreignAssetAddress = m.getParameter(
    "foreignAssetAddress",
    "0x0000000000000000000000000000000000000801"
  );

  // Decimals must match the native AJUN asset (12 on Ajuna Network).
  const tokenDecimals = m.getParameter("tokenDecimals", 12);

  const adminAddress = m.getAccount(0); // Deployer is initial admin

  // ──────────────────────────────────────────────
  //  1. Deploy AjunaERC20 (UUPS proxy)
  // ──────────────────────────────────────────────

  // 1a. Deploy implementation
  const tokenImpl = m.contract("AjunaERC20", [], { id: "AjunaERC20Impl" });

  // 1b. Encode initialize() calldata
  const tokenInitData = new ethers.Interface([
    "function initialize(string,string,address,uint8)",
  ]).encodeFunctionData("initialize", [
    "Wrapped Ajuna",
    "WAJUN",
    adminAddress,
    tokenDecimals,
  ]);

  // 1c. Deploy proxy
  const tokenProxy = m.contract(
    "ERC1967Proxy",
    [tokenImpl, tokenInitData],
    { id: "AjunaERC20Proxy" }
  );

  // ──────────────────────────────────────────────
  //  2. Deploy AjunaWrapper (UUPS proxy)
  // ──────────────────────────────────────────────

  // 2a. Deploy implementation
  const wrapperImpl = m.contract("AjunaWrapper", [], { id: "AjunaWrapperImpl" });

  // 2b. Encode initialize() calldata
  const wrapperInitData = new ethers.Interface([
    "function initialize(address,address)",
  ]).encodeFunctionData("initialize", [
    tokenProxy,      // Will resolve to the proxy address
    foreignAssetAddress,
  ]);

  // 2c. Deploy proxy
  const wrapperProxy = m.contract(
    "ERC1967Proxy",
    [wrapperImpl, wrapperInitData],
    { id: "AjunaWrapperProxy" }
  );

  // ──────────────────────────────────────────────
  //  3. Grant MINTER_ROLE to Wrapper proxy
  // ──────────────────────────────────────────────

  // MINTER_ROLE = keccak256("MINTER_ROLE")
  const MINTER_ROLE =
    "0x9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a6";

  // Call grantRole on the proxy (which delegates to the implementation)
  m.call(tokenProxy, "grantRole", [MINTER_ROLE, wrapperProxy], {
    id: "grantMinterRole",
  });

  // NOTE: After deployment, manually:
  //   1. Transfer DEFAULT_ADMIN_ROLE and ownership to a multisig, then renounce from deployer.
  //   2. Send 1–2 DOT to the wrapper proxy address as Existential Deposit.

  return { tokenImpl, tokenProxy, wrapperImpl, wrapperProxy };
});

export default AjunaWrapperModule;
