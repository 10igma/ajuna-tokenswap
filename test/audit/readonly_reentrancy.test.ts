import { expect } from "chai";
import { ethers } from "hardhat";

/**
 * PoC for ATS-11 — Read-only reentrancy on `isInvariantHealthy()`.
 *
 * POST-FIX: `isInvariantHealthy()` (and the new `getInvariantDelta` /
 * `isUnderCollateralized` sister views) carry the `nonReentrantView` modifier
 * from OZ 5.6.1 ReentrancyGuard. Mid-deposit re-entry into the view now
 * reverts rather than returning a transient over-collateralized snapshot.
 *
 * The snoop foreign asset wraps its query in `try/catch`, so the deposit
 * still completes. After the tx: `observed == true` (the snoop attempted
 * the read) and `lastObservation == false` (the catch fired because the
 * view reverted). This proves the view-side reentrancy lever is closed.
 */
describe("[AUDIT] ATS-11 — nonReentrantView blocks mid-deposit observation (post-fix)", function () {
  it("isInvariantHealthy() reverts when called inside a wrapper.deposit() call frame", async function () {
    const [owner, user] = await ethers.getSigners();

    // Token (wAJUN) standard fixture
    const TokenFactory = await ethers.getContractFactory("AjunaERC20");
    const tokenImpl = await TokenFactory.deploy();
    await tokenImpl.waitForDeployment();
    const tInit = TokenFactory.interface.encodeFunctionData("initialize", [
      "Wrapped Ajuna",
      "WAJUN",
      owner.address,
      12,
      0,
    ]);
    const ProxyFactory = await ethers.getContractFactory("ERC1967Proxy");
    const tProxy = await ProxyFactory.deploy(await tokenImpl.getAddress(), tInit);
    await tProxy.waitForDeployment();
    const token = TokenFactory.attach(await tProxy.getAddress());

    // Snoop foreign-asset mock
    const Snoop = await ethers.getContractFactory("InvariantSnoopToken");
    const snoop = await Snoop.deploy();
    await snoop.waitForDeployment();

    // Wrapper pointed at the snoop foreign asset
    const WrapperFactory = await ethers.getContractFactory("AjunaWrapper");
    const wImpl = await WrapperFactory.deploy();
    await wImpl.waitForDeployment();
    const wInit = WrapperFactory.interface.encodeFunctionData("initialize", [
      await tProxy.getAddress(),
      await snoop.getAddress(),
    ]);
    const wProxy = await ProxyFactory.deploy(await wImpl.getAddress(), wInit);
    await wProxy.waitForDeployment();
    const wrapper = WrapperFactory.attach(await wProxy.getAddress());
    await (wrapper as any).connect(owner).setAllowlistEnabled(false);

    // Wire the mock to call back into wrapper.isInvariantHealthy() during transferFrom
    await (snoop as any).setWrapper(await wProxy.getAddress());

    // Grant MINTER_ROLE to wrapper
    const MINTER_ROLE = await token.MINTER_ROLE();
    await (token as any).connect(owner).grantRole(MINTER_ROLE, await wProxy.getAddress());

    // Mint snoop tokens to user, approve wrapper
    const amount = ethers.parseUnits("100", 12);
    await (snoop as any).mintTo(user.address, amount);
    await (snoop as any).connect(user).approve(await wProxy.getAddress(), amount);

    // Deposit succeeds end-to-end
    await (wrapper as any).connect(user).deposit(amount);

    // After tx: invariant healthy from a normal (non-reentrant) caller.
    expect(await wrapper.isInvariantHealthy()).to.be.true;

    // The snoop attempted the read, but `nonReentrantView` rejected it.
    // The snoop's try/catch fires; it records observed=true with
    // lastObservation=false (the catch's default). This proves the
    // read-only-reentrancy surface is closed: no on-chain consumer can
    // observe a transient mid-deposit state through this view.
    expect(await (snoop as any).observed()).to.equal(true);
    expect(await (snoop as any).lastObservation()).to.equal(false);
  });
});
