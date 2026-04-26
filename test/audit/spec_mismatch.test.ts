import { expect } from "chai";
import { ethers } from "hardhat";

/**
 * PoC for ATS-02 — `scripts/deploy_production.sh` post-deploy section instructs
 * operators to perform two operations that the actual contract code rejects:
 *
 *   Step 4: AjunaERC20: grantRole(DEFAULT_ADMIN_ROLE, multisig)
 *   Step 5: AjunaERC20: renounceRole(DEFAULT_ADMIN_ROLE, deployer)
 *
 * The contract uses `AccessControlDefaultAdminRulesUpgradeable`, which blocks
 * both single-step `grantRole`/`renounceRole` on `DEFAULT_ADMIN_ROLE` — the
 * correct flow is `beginDefaultAdminTransfer` → `acceptDefaultAdminTransfer`.
 *
 * `docs/PRODUCTION-CHECKLIST.md` documents the correct flow; the shell helper
 * does not. Two reference paths diverge on a critical operational step.
 */
describe("[AUDIT] ATS-02 — deploy_production.sh contradicts AccessControlDefaultAdminRules", function () {
  it("step 4 (grantRole(DEFAULT_ADMIN_ROLE, multisig)) reverts", async function () {
    const [deployer, multisig] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("AjunaERC20");
    const impl = await Factory.deploy();
    await impl.waitForDeployment();
    const initData = Factory.interface.encodeFunctionData("initialize", [
      "Wrapped Ajuna",
      "WAJUN",
      deployer.address,
      12,
      0, // adminDelay = 0 — no time-gating in test
    ]);
    const ProxyFactory = await ethers.getContractFactory("ERC1967Proxy");
    const proxy = await ProxyFactory.deploy(await impl.getAddress(), initData);
    await proxy.waitForDeployment();
    const token = Factory.attach(await proxy.getAddress());

    const DEFAULT_ADMIN_ROLE = await token.DEFAULT_ADMIN_ROLE();
    // Direct grantRole(DEFAULT_ADMIN_ROLE, ...) — exactly what deploy_production.sh tells the operator to call.
    await expect(
      token.connect(deployer).grantRole(DEFAULT_ADMIN_ROLE, multisig.address)
    ).to.be.reverted; // AccessControlEnforcedDefaultAdminRules
  });

  it("step 5 (renounceRole(DEFAULT_ADMIN_ROLE, deployer)) reverts when no transfer is pending", async function () {
    const [deployer] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("AjunaERC20");
    const impl = await Factory.deploy();
    await impl.waitForDeployment();
    const initData = Factory.interface.encodeFunctionData("initialize", [
      "Wrapped Ajuna",
      "WAJUN",
      deployer.address,
      12,
      0,
    ]);
    const ProxyFactory = await ethers.getContractFactory("ERC1967Proxy");
    const proxy = await ProxyFactory.deploy(await impl.getAddress(), initData);
    await proxy.waitForDeployment();
    const token = Factory.attach(await proxy.getAddress());

    const DEFAULT_ADMIN_ROLE = await token.DEFAULT_ADMIN_ROLE();
    await expect(
      token.connect(deployer).renounceRole(DEFAULT_ADMIN_ROLE, deployer.address)
    ).to.be.reverted; // schedule check fails (no begin → no schedule)
  });
});

/**
 * PoC for ATS-04 — AjunaWrapperV2 mock template has an unprotected
 * `migrateToV2()` (`external reinitializer(2)` only — no `onlyOwner`).
 *
 * This is acceptable for a test fixture, but UPGRADE.md presents the V2 mocks
 * as the canonical V2 template. If a future contributor copies the wrapper
 * V2 pattern verbatim into production, the migration function becomes a
 * front-runnable race during the upgradeToAndCall window — anyone observing
 * a pending upgrade tx in the mempool can call `migrateToV2()` directly and
 * arbitrarily reinitialize storage one block earlier than intended.
 *
 * The ERC20 V2 mock has the same flaw. The matching example in UPGRADE.md
 * (lines 144–158) gates migration with `onlyRole(UPGRADER_ROLE)` — so the
 * docs are right but the in-tree mocks are wrong.
 */
describe("[AUDIT] ATS-04 — V2 mock migration is now access-controlled (post-fix)", function () {
  it("AjunaWrapperV2.migrateToV2 reverts when called by a non-owner attacker", async function () {
    const [owner, attacker] = await ethers.getSigners();

    // Deploy token + wrapper as in the standard fixture
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

    const WrapperFactory = await ethers.getContractFactory("AjunaWrapper");
    const wImpl = await WrapperFactory.deploy();
    await wImpl.waitForDeployment();
    const wInit = WrapperFactory.interface.encodeFunctionData("initialize", [
      await tProxy.getAddress(),
      await tProxy.getAddress(),
    ]);
    const wProxy = await ProxyFactory.deploy(await wImpl.getAddress(), wInit);
    await wProxy.waitForDeployment();

    // Owner upgrades to V2 *without* calling migrateToV2 atomically (i.e. plain upgradeToAndCall(impl, "0x"))
    const V2 = await ethers.getContractFactory("AjunaWrapperV2");
    const v2Impl = await V2.deploy();
    await v2Impl.waitForDeployment();
    const wrapper = WrapperFactory.attach(await wProxy.getAddress());
    await (wrapper as any).connect(owner).upgradeToAndCall(await v2Impl.getAddress(), "0x");

    // POST-FIX (ATS-03): non-owner cannot finalize the migration. Without
    // the fix, an attacker watching the mempool could front-run the
    // owner's planned `migrateToV2` call.
    const wrapperV2 = V2.attach(await wProxy.getAddress());
    await expect((wrapperV2 as any).connect(attacker).migrateToV2()).to.be.reverted;

    // Owner can still call it — verify the happy path works.
    await (wrapperV2 as any).connect(owner).migrateToV2();
    expect(await (wrapperV2 as any).version()).to.equal(2);
  });

  it("AjunaERC20V2.migrateToV2 reverts when called by a non-UPGRADER account", async function () {
    const [owner, attacker] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("AjunaERC20");
    const impl = await Factory.deploy();
    await impl.waitForDeployment();
    const initData = Factory.interface.encodeFunctionData("initialize", [
      "Wrapped Ajuna",
      "WAJUN",
      owner.address,
      12,
      0,
    ]);
    const ProxyFactory = await ethers.getContractFactory("ERC1967Proxy");
    const proxy = await ProxyFactory.deploy(await impl.getAddress(), initData);
    await proxy.waitForDeployment();
    const token = Factory.attach(await proxy.getAddress());

    const V2 = await ethers.getContractFactory("AjunaERC20V2");
    const v2Impl = await V2.deploy();
    await v2Impl.waitForDeployment();
    await (token as any).connect(owner).upgradeToAndCall(await v2Impl.getAddress(), "0x");

    // POST-FIX (ATS-03): non-UPGRADER cannot finalize the migration.
    const tokenV2 = V2.attach(await proxy.getAddress());
    await expect((tokenV2 as any).connect(attacker).migrateToV2()).to.be.reverted;

    // Owner (the UPGRADER_ROLE holder) can.
    await (tokenV2 as any).connect(owner).migrateToV2();
    expect(await (tokenV2 as any).version()).to.equal(2);
  });
});

/**
 * PoC for ATS-06 — wrapper.owner() and erc20.defaultAdmin() are not bound
 * by code. If the post-deploy hand-off leaves the wrapper owner as the
 * multisig but the ERC20 default admin as a different EOA (or vice versa),
 * the ERC20 admin can grant MINTER_ROLE to themselves and mint unbacked
 * wAJUN — breaking the 1:1 backing invariant.
 *
 * This is a centralization / operational coupling risk. The contracts cannot
 * detect the divergence; only the off-chain monitor recommended in
 * `docs/PRODUCTION-CHECKLIST.md` Phase 9C can.
 */
describe("[AUDIT] ATS-04/06 — bindMinter prevents the divergence-mint attack (post-fix)", function () {
  it("when bindMinter is called, a rogue ERC20 admin CANNOT grant MINTER_ROLE elsewhere or mint unbacked wAJUN", async function () {
    const [deployer, wrapperMultisig, rogueErc20Admin, victim] = await ethers.getSigners();

    // Deploy fresh fixture with deployer holding both roles
    const TokenFactory = await ethers.getContractFactory("AjunaERC20");
    const tokenImpl = await TokenFactory.deploy();
    await tokenImpl.waitForDeployment();
    const tInit = TokenFactory.interface.encodeFunctionData("initialize", [
      "Wrapped Ajuna",
      "WAJUN",
      deployer.address,
      12,
      0,
    ]);
    const ProxyFactory = await ethers.getContractFactory("ERC1967Proxy");
    const tProxy = await ProxyFactory.deploy(await tokenImpl.getAddress(), tInit);
    await tProxy.waitForDeployment();
    const token = TokenFactory.attach(await tProxy.getAddress());

    // Deploy a mock foreign asset for context
    const faImpl = await TokenFactory.deploy();
    await faImpl.waitForDeployment();
    const faInit = TokenFactory.interface.encodeFunctionData("initialize", [
      "Foreign AJUN",
      "AJUN",
      deployer.address,
      12,
      0,
    ]);
    const faProxy = await ProxyFactory.deploy(await faImpl.getAddress(), faInit);
    await faProxy.waitForDeployment();
    const fa = TokenFactory.attach(await faProxy.getAddress());

    const WrapperFactory = await ethers.getContractFactory("AjunaWrapper");
    const wImpl = await WrapperFactory.deploy();
    await wImpl.waitForDeployment();
    const wInit = WrapperFactory.interface.encodeFunctionData("initialize", [
      await tProxy.getAddress(),
      await faProxy.getAddress(),
    ]);
    const wProxy = await ProxyFactory.deploy(await wImpl.getAddress(), wInit);
    await wProxy.waitForDeployment();
    const wrapper = WrapperFactory.attach(await wProxy.getAddress());
    await (wrapper as any).connect(deployer).setAllowlistEnabled(false);

    // POST-FIX (ATS-04): use bindMinter — sets boundMinter and grants MINTER_ROLE
    // atomically. After this, no other address can ever hold MINTER_ROLE.
    const MINTER_ROLE = await token.MINTER_ROLE();
    await (token as any).connect(deployer).bindMinter(await wProxy.getAddress());

    // Hand-off MISCONFIGURED:
    //   wrapper.owner() → wrapperMultisig (intended)
    //   erc20.defaultAdmin() → rogueErc20Admin (different — e.g. typo, partial hand-off)
    await (wrapper as any).connect(deployer).transferOwnership(wrapperMultisig.address);
    await (wrapper as any).connect(wrapperMultisig).acceptOwnership();
    await (token as any).connect(deployer).beginDefaultAdminTransfer(rogueErc20Admin.address);
    await (token as any).connect(rogueErc20Admin).acceptDefaultAdminTransfer();

    expect(await wrapper.owner()).to.equal(wrapperMultisig.address);
    expect(await (token as any).defaultAdmin()).to.equal(rogueErc20Admin.address);

    // POST-FIX: the rogue admin's attempt to grant themselves MINTER_ROLE
    // reverts because boundMinter is already set to the wrapper.
    await expect(
      (token as any).connect(rogueErc20Admin).grantRole(MINTER_ROLE, rogueErc20Admin.address)
    ).to.be.revertedWith("AjunaERC20: MINTER_ROLE bound to a single address");

    // bindMinter is one-shot — even the rogue admin cannot re-bind to themselves.
    await expect(
      (token as any).connect(rogueErc20Admin).bindMinter(rogueErc20Admin.address)
    ).to.be.revertedWith("AjunaERC20: minter already bound");

    // Invariant intact: no unbacked wAJUN can be minted.
    expect(await token.totalSupply()).to.equal(0n);
    expect(await fa.balanceOf(await wProxy.getAddress())).to.equal(0n);
    expect(await wrapper.isInvariantHealthy()).to.be.true;
  });
});
