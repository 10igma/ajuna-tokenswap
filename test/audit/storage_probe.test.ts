import { expect } from "chai";
import { ethers } from "hardhat";

// keccak256(abi.encode(uint256(keccak256("openzeppelin.storage.ReentrancyGuard")) - 1)) & ~bytes32(uint256(0xff))
const REENTRANCY_GUARD_SLOT =
  "0x9b779b17422d0df92223018b32b4d1fa46e071723d6817e2486d003becc55f00";

describe("[AUDIT] storage probe — ReentrancyGuard namespaced slot on proxy (post-ATS-09 fix)", function () {
  it("proxy storage at the namespaced ReentrancyGuard slot is initialized to 1 (NOT_ENTERED) by initialize()", async () => {
    const [owner, user] = await ethers.getSigners();

    // Deploy AjunaERC20 token (so the wrapper has something to point at)
    const TokenFactory = await ethers.getContractFactory("AjunaERC20");
    const tokenImpl = await TokenFactory.deploy();
    await tokenImpl.waitForDeployment();
    const initData = TokenFactory.interface.encodeFunctionData("initialize", [
      "Wrapped Ajuna",
      "WAJUN",
      owner.address,
      12,
      0,
    ]);
    const ProxyFactory = await ethers.getContractFactory("ERC1967Proxy");
    const tokenProxy = await ProxyFactory.deploy(await tokenImpl.getAddress(), initData);
    await tokenProxy.waitForDeployment();

    // Deploy AjunaWrapper via proxy
    const WrapperFactory = await ethers.getContractFactory("AjunaWrapper");
    const wrapperImpl = await WrapperFactory.deploy();
    await wrapperImpl.waitForDeployment();
    const wrapperInit = WrapperFactory.interface.encodeFunctionData("initialize", [
      await tokenProxy.getAddress(),
      await tokenProxy.getAddress(), // any non-zero "foreign asset" — we don't call deposit here
    ]);
    const wrapperProxy = await ProxyFactory.deploy(
      await wrapperImpl.getAddress(),
      wrapperInit
    );
    await wrapperProxy.waitForDeployment();

    const proxyAddr = await wrapperProxy.getAddress();
    const implAddr = await wrapperImpl.getAddress();

    // POST-FIX (ATS-09): the wrapper now uses an inline reentrancy guard
    // (no inherited constructor-bearing parent), so the implementation's
    // namespaced slot is untouched at deploy time (0).
    const implStatus = await ethers.provider.getStorage(implAddr, REENTRANCY_GUARD_SLOT);
    expect(BigInt(implStatus)).to.equal(0n, "implementation _status is 0 — no parent constructor writes the slot anymore");

    // The proxy's namespaced slot is explicitly written to NOT_ENTERED (1)
    // by AjunaWrapper.initialize(). The "safe by accident because 0 != ENTERED"
    // qualifier from the audit no longer applies — the safety story is now
    // "explicitly initialized on first use".
    const proxyStatus = await ethers.provider.getStorage(proxyAddr, REENTRANCY_GUARD_SLOT);
    expect(BigInt(proxyStatus)).to.equal(1n, "proxy _status is initialized to 1 (NOT_ENTERED) by initialize() per ATS-09 fix");
  });
});
