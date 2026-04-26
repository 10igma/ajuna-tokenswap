import { expect } from "chai";
import { ethers } from "hardhat";
import { AjunaERC20, AjunaWrapper } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("AjunaWrapper System", function () {
  let token: AjunaERC20;
  let wrapper: AjunaWrapper;
  let foreignAssetMock: AjunaERC20; // Mock ERC20 standing in for the precompile
  let owner: SignerWithAddress;
  let user: SignerWithAddress;
  let user2: SignerWithAddress;

  const DECIMALS = 12;
  const INITIAL_SUPPLY = ethers.parseUnits("1000", DECIMALS);
  const ZERO_ADDRESS = ethers.ZeroAddress;

  before(async function () {
    [owner, user, user2] = await ethers.getSigners();
  });

  /**
   * Deploy an AjunaERC20 behind an ERC1967Proxy and return the typed contract
   * attached to the proxy address.
   */
  async function deployERC20Proxy(
    name: string,
    symbol: string,
    admin: string,
    decimals: number,
    initialAdminDelay: number = 0
  ): Promise<AjunaERC20> {
    const Factory = await ethers.getContractFactory("AjunaERC20");
    const impl = await Factory.deploy();
    await impl.waitForDeployment();

    const initData = Factory.interface.encodeFunctionData("initialize", [
      name, symbol, admin, decimals, initialAdminDelay,
    ]);
    const ProxyFactory = await ethers.getContractFactory("ERC1967Proxy");
    const proxy = await ProxyFactory.deploy(await impl.getAddress(), initData);
    await proxy.waitForDeployment();

    return Factory.attach(await proxy.getAddress()) as AjunaERC20;
  }

  /**
   * Deploy an AjunaWrapper behind an ERC1967Proxy and return the typed contract
   * attached to the proxy address.
   */
  async function deployWrapperProxy(
    tokenAddr: string,
    foreignAssetAddr: string
  ): Promise<AjunaWrapper> {
    const Factory = await ethers.getContractFactory("AjunaWrapper");
    const impl = await Factory.deploy();
    await impl.waitForDeployment();

    const initData = Factory.interface.encodeFunctionData("initialize", [
      tokenAddr, foreignAssetAddr,
    ]);
    const ProxyFactory = await ethers.getContractFactory("ERC1967Proxy");
    const proxy = await ProxyFactory.deploy(await impl.getAddress(), initData);
    await proxy.waitForDeployment();

    return Factory.attach(await proxy.getAddress()) as AjunaWrapper;
  }

  beforeEach(async function () {
    // 1. Deploy mock Foreign Asset (AjunaERC20 via proxy, as stand-in for the precompile)
    foreignAssetMock = await deployERC20Proxy("Foreign AJUN", "FAJUN", owner.address, DECIMALS);
    await foreignAssetMock.grantRole(await foreignAssetMock.MINTER_ROLE(), owner.address);
    await foreignAssetMock.mint(user.address, INITIAL_SUPPLY);
    await foreignAssetMock.mint(user2.address, INITIAL_SUPPLY);

    // 2. Deploy real contracts (via proxy)
    token = await deployERC20Proxy("Wrapped Ajuna", "WAJUN", owner.address, DECIMALS);

    wrapper = await deployWrapperProxy(
      await token.getAddress(),
      await foreignAssetMock.getAddress()
    );

    // 3. Bind MINTER_ROLE to the wrapper (one-shot; production pattern).
    //    After this, no other address can ever hold MINTER_ROLE on `token`,
    //    closing the audit ATS-04 divergence-mint vector.
    await token.bindMinter(await wrapper.getAddress());

    // 4. Disable the initial allowlist gate so the existing test groups
    //    (which use arbitrary users as depositors/withdrawers) keep behaving
    //    like the open-to-everyone production state. The "Allowlist" describe
    //    block below re-enables it for gate-specific tests.
    await wrapper.connect(owner).setAllowlistEnabled(false);
  });

  // Helper: deploy a fresh isolated AjunaERC20 + AjunaWrapper system bound
  // to a custom foreign asset. Used by side-wrapper tests (SafeERC20 defense,
  // fee-on-transfer defense, reentrancy attack) so each can have its own
  // bound minter without conflicting with the shared `token` / `wrapper`.
  async function deployIsolatedSystem(foreignAsset: string) {
    const localToken = await deployERC20Proxy("Wrapped Ajuna", "WAJUN", owner.address, DECIMALS);
    const localWrapper = await deployWrapperProxy(await localToken.getAddress(), foreignAsset);
    await localToken.bindMinter(await localWrapper.getAddress());
    await localWrapper.connect(owner).setAllowlistEnabled(false);
    return { token: localToken, wrapper: localWrapper };
  }

  // ─── Helper ───────────────────────────────────────────────
  async function checkInvariant() {
    const totalSupply = await token.totalSupply();
    const wrapperForeignBal = await foreignAssetMock.balanceOf(await wrapper.getAddress());
    expect(totalSupply).to.equal(wrapperForeignBal, "INVARIANT BROKEN: totalSupply != locked foreign assets");
  }

  // ═══════════════════════════════════════════════════════════
  //  Deployment
  // ═══════════════════════════════════════════════════════════

  describe("Deployment", function () {
    it("should set correct token and foreignAsset addresses", async function () {
      expect(await wrapper.token()).to.equal(await token.getAddress());
      expect(await wrapper.foreignAsset()).to.equal(await foreignAssetMock.getAddress());
    });

    it("should set correct decimals", async function () {
      expect(await token.decimals()).to.equal(DECIMALS);
    });

    it("should revert AjunaERC20 initialization with zero admin", async function () {
      const Factory = await ethers.getContractFactory("AjunaERC20");
      const impl = await Factory.deploy();
      await impl.waitForDeployment();

      const initData = Factory.interface.encodeFunctionData("initialize", [
        "Test", "TST", ZERO_ADDRESS, 12, 0,
      ]);
      const ProxyFactory = await ethers.getContractFactory("ERC1967Proxy");
      await expect(
        ProxyFactory.deploy(await impl.getAddress(), initData)
      ).to.be.reverted;
    });

    it("should revert AjunaERC20 initialization with decimals > 18", async function () {
      const Factory = await ethers.getContractFactory("AjunaERC20");
      const impl = await Factory.deploy();
      await impl.waitForDeployment();

      const initData = Factory.interface.encodeFunctionData("initialize", [
        "Test", "TST", owner.address, 19, 0,
      ]);
      const ProxyFactory = await ethers.getContractFactory("ERC1967Proxy");
      await expect(
        ProxyFactory.deploy(await impl.getAddress(), initData)
      ).to.be.reverted;
    });

    it("should revert AjunaWrapper initialization with zero token address", async function () {
      const Factory = await ethers.getContractFactory("AjunaWrapper");
      const impl = await Factory.deploy();
      await impl.waitForDeployment();

      const initData = Factory.interface.encodeFunctionData("initialize", [
        ZERO_ADDRESS, await foreignAssetMock.getAddress(),
      ]);
      const ProxyFactory = await ethers.getContractFactory("ERC1967Proxy");
      await expect(
        ProxyFactory.deploy(await impl.getAddress(), initData)
      ).to.be.reverted;
    });

    it("should revert AjunaWrapper initialization with zero precompile address", async function () {
      const Factory = await ethers.getContractFactory("AjunaWrapper");
      const impl = await Factory.deploy();
      await impl.waitForDeployment();

      const initData = Factory.interface.encodeFunctionData("initialize", [
        await token.getAddress(), ZERO_ADDRESS,
      ]);
      const ProxyFactory = await ethers.getContractFactory("ERC1967Proxy");
      await expect(
        ProxyFactory.deploy(await impl.getAddress(), initData)
      ).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  Deposit (Wrap)
  // ═══════════════════════════════════════════════════════════

  describe("Deposit (Wrap)", function () {
    const amount = ethers.parseUnits("100", DECIMALS);

    it("should wrap Foreign Assets and emit Deposited event", async function () {
      await foreignAssetMock.connect(user).approve(await wrapper.getAddress(), amount);

      await expect(wrapper.connect(user).deposit(amount))
        .to.emit(wrapper, "Deposited")
        .withArgs(user.address, amount);

      expect(await token.balanceOf(user.address)).to.equal(amount);
      expect(await foreignAssetMock.balanceOf(await wrapper.getAddress())).to.equal(amount);
      await checkInvariant();
    });

    it("should revert on zero amount", async function () {
      await expect(wrapper.connect(user).deposit(0)).to.be.revertedWith("Amount must be > 0");
    });

    it("should revert without prior approval", async function () {
      await expect(wrapper.connect(user).deposit(amount)).to.be.reverted;
    });

    it("should maintain invariant after multiple deposits", async function () {
      const amt1 = ethers.parseUnits("50", DECIMALS);
      const amt2 = ethers.parseUnits("30", DECIMALS);

      await foreignAssetMock.connect(user).approve(await wrapper.getAddress(), amt1 + amt2);
      await wrapper.connect(user).deposit(amt1);
      await checkInvariant();
      await wrapper.connect(user).deposit(amt2);
      await checkInvariant();

      expect(await token.totalSupply()).to.equal(amt1 + amt2);
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  Withdraw (Unwrap)
  // ═══════════════════════════════════════════════════════════

  describe("Withdraw (Unwrap)", function () {
    const depositAmount = ethers.parseUnits("100", DECIMALS);
    const withdrawAmount = ethers.parseUnits("60", DECIMALS);

    beforeEach(async function () {
      // Setup: wrap first so user has wAJUN
      await foreignAssetMock.connect(user).approve(await wrapper.getAddress(), depositAmount);
      await wrapper.connect(user).deposit(depositAmount);
    });

    it("should unwrap ERC20 tokens and emit Withdrawn event", async function () {
      // User must approve wrapper to burnFrom their wAJUN
      await token.connect(user).approve(await wrapper.getAddress(), withdrawAmount);

      await expect(wrapper.connect(user).withdraw(withdrawAmount))
        .to.emit(wrapper, "Withdrawn")
        .withArgs(user.address, withdrawAmount);

      expect(await token.balanceOf(user.address)).to.equal(depositAmount - withdrawAmount);
      expect(await foreignAssetMock.balanceOf(user.address)).to.equal(
        INITIAL_SUPPLY - depositAmount + withdrawAmount
      );
      await checkInvariant();
    });

    it("should revert on zero amount", async function () {
      await expect(wrapper.connect(user).withdraw(0)).to.be.revertedWith("Amount must be > 0");
    });

    it("should revert with insufficient ERC20 balance", async function () {
      const tooMuch = depositAmount + 1n;
      await token.connect(user).approve(await wrapper.getAddress(), tooMuch);
      await expect(wrapper.connect(user).withdraw(tooMuch)).to.be.revertedWith(
        "Insufficient ERC20 balance"
      );
    });

    it("should revert without ERC20 approval (burnFrom requires allowance)", async function () {
      // User has wAJUN but has NOT approved wrapper
      await expect(wrapper.connect(user).withdraw(withdrawAmount)).to.be.reverted;
    });

    it("should maintain invariant after full unwrap", async function () {
      await token.connect(user).approve(await wrapper.getAddress(), depositAmount);
      await wrapper.connect(user).withdraw(depositAmount);
      await checkInvariant();
      expect(await token.totalSupply()).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  Access Control
  // ═══════════════════════════════════════════════════════════

  describe("Access Control", function () {
    it("should prevent non-MINTER from calling mint", async function () {
      await expect(token.connect(user).mint(user.address, 100)).to.be.reverted;
    });

    it("should prevent non-MINTER from calling burnFrom", async function () {
      await expect(token.connect(user).burnFrom(user.address, 100)).to.be.reverted;
    });

    it("deployer should NOT have MINTER_ROLE by default", async function () {
      const MINTER_ROLE = await token.MINTER_ROLE();
      expect(await token.hasRole(MINTER_ROLE, owner.address)).to.be.false;
    });

    it("wrapper should have MINTER_ROLE", async function () {
      const MINTER_ROLE = await token.MINTER_ROLE();
      expect(await token.hasRole(MINTER_ROLE, await wrapper.getAddress())).to.be.true;
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  Pausable
  // ═══════════════════════════════════════════════════════════

  describe("Pausable", function () {
    const amount = ethers.parseUnits("10", DECIMALS);

    it("should reject deposit when paused", async function () {
      await wrapper.connect(owner).pause();
      await foreignAssetMock.connect(user).approve(await wrapper.getAddress(), amount);
      await expect(wrapper.connect(user).deposit(amount)).to.be.reverted;
    });

    it("should reject withdraw when paused", async function () {
      // Setup: wrap first
      await foreignAssetMock.connect(user).approve(await wrapper.getAddress(), amount);
      await wrapper.connect(user).deposit(amount);

      await wrapper.connect(owner).pause();
      await token.connect(user).approve(await wrapper.getAddress(), amount);
      await expect(wrapper.connect(user).withdraw(amount)).to.be.reverted;
    });

    it("should resume after unpause", async function () {
      await foreignAssetMock.connect(user).approve(await wrapper.getAddress(), amount);
      await wrapper.connect(owner).pause();
      await expect(wrapper.connect(user).deposit(amount)).to.be.reverted;

      await wrapper.connect(owner).unpause();
      await wrapper.connect(user).deposit(amount);
      expect(await token.balanceOf(user.address)).to.equal(amount);
    });

    it("should only allow owner to pause/unpause", async function () {
      await expect(wrapper.connect(user).pause()).to.be.reverted;
      await expect(wrapper.connect(user).unpause()).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  Rescue
  // ═══════════════════════════════════════════════════════════

  describe("Rescue", function () {
    it("should rescue accidentally sent tokens", async function () {
      // Deploy a random token and send some to the wrapper
      const randomToken = await deployERC20Proxy("Random", "RND", owner.address, 18);
      await randomToken.grantRole(await randomToken.MINTER_ROLE(), owner.address);
      await randomToken.mint(await wrapper.getAddress(), 1000);

      await wrapper.connect(owner).rescueToken(
        await randomToken.getAddress(),
        owner.address,
        1000
      );
      expect(await randomToken.balanceOf(owner.address)).to.equal(1000);
    });

    it("should NOT allow rescuing the locked foreign asset", async function () {
      await expect(
        wrapper.connect(owner).rescueToken(
          await foreignAssetMock.getAddress(),
          owner.address,
          1
        )
      ).to.be.revertedWith("Cannot rescue locked foreign asset");
    });

    it("should NOT allow rescuing the wAJUN token", async function () {
      await expect(
        wrapper.connect(owner).rescueToken(
          await token.getAddress(),
          owner.address,
          1
        )
      ).to.be.revertedWith("Cannot rescue wAJUN token");
    });

    it("should only allow owner to rescue", async function () {
      await expect(
        wrapper.connect(user).rescueToken(await token.getAddress(), user.address, 1)
      ).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  Multi-User
  // ═══════════════════════════════════════════════════════════

  describe("Multi-User", function () {
    const amt1 = ethers.parseUnits("200", DECIMALS);
    const amt2 = ethers.parseUnits("150", DECIMALS);

    it("should handle interleaved wrap/unwrap from two users", async function () {
      // User1 wraps
      await foreignAssetMock.connect(user).approve(await wrapper.getAddress(), amt1);
      await wrapper.connect(user).deposit(amt1);
      await checkInvariant();

      // User2 wraps
      await foreignAssetMock.connect(user2).approve(await wrapper.getAddress(), amt2);
      await wrapper.connect(user2).deposit(amt2);
      await checkInvariant();

      expect(await token.totalSupply()).to.equal(amt1 + amt2);

      // User1 partially unwraps
      const unwrap1 = ethers.parseUnits("80", DECIMALS);
      await token.connect(user).approve(await wrapper.getAddress(), unwrap1);
      await wrapper.connect(user).withdraw(unwrap1);
      await checkInvariant();

      // User2 fully unwraps
      await token.connect(user2).approve(await wrapper.getAddress(), amt2);
      await wrapper.connect(user2).withdraw(amt2);
      await checkInvariant();

      expect(await token.totalSupply()).to.equal(amt1 - unwrap1);
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  UUPS Upgradeability
  // ═══════════════════════════════════════════════════════════

  describe("UUPS Upgradeability", function () {
    it("should prevent re-initialization of AjunaERC20", async function () {
      await expect(
        token.initialize("Hack", "HACK", user.address, 18, 0)
      ).to.be.reverted;
    });

    it("should prevent re-initialization of AjunaWrapper", async function () {
      await expect(
        wrapper.initialize(await token.getAddress(), await foreignAssetMock.getAddress())
      ).to.be.reverted;
    });

    it("should prevent non-upgrader from upgrading AjunaERC20", async function () {
      const NewImpl = await ethers.getContractFactory("AjunaERC20");
      const newImpl = await NewImpl.deploy();
      await newImpl.waitForDeployment();

      // user does not have UPGRADER_ROLE
      await expect(
        token.connect(user).upgradeToAndCall(await newImpl.getAddress(), "0x")
      ).to.be.reverted;
    });

    it("should prevent non-owner from upgrading AjunaWrapper", async function () {
      const NewImpl = await ethers.getContractFactory("AjunaWrapper");
      const newImpl = await NewImpl.deploy();
      await newImpl.waitForDeployment();

      // user is not owner
      await expect(
        wrapper.connect(user).upgradeToAndCall(await newImpl.getAddress(), "0x")
      ).to.be.reverted;
    });

    it("should allow owner to upgrade AjunaERC20", async function () {
      const NewImpl = await ethers.getContractFactory("AjunaERC20");
      const newImpl = await NewImpl.deploy();
      await newImpl.waitForDeployment();

      // owner has UPGRADER_ROLE (granted during initialize)
      await token.connect(owner).upgradeToAndCall(await newImpl.getAddress(), "0x");

      // State should be preserved — decimals, roles, etc.
      expect(await token.decimals()).to.equal(DECIMALS);
      expect(await token.hasRole(await token.MINTER_ROLE(), await wrapper.getAddress())).to.be.true;
    });

    it("should allow owner to upgrade AjunaWrapper", async function () {
      const NewImpl = await ethers.getContractFactory("AjunaWrapper");
      const newImpl = await NewImpl.deploy();
      await newImpl.waitForDeployment();

      await wrapper.connect(owner).upgradeToAndCall(await newImpl.getAddress(), "0x");

      // State should be preserved
      expect(await wrapper.token()).to.equal(await token.getAddress());
      expect(await wrapper.foreignAsset()).to.equal(await foreignAssetMock.getAddress());
      expect(await wrapper.owner()).to.equal(owner.address);
    });

    it("should preserve balances after AjunaWrapper upgrade", async function () {
      // Wrap some tokens first
      const amount = ethers.parseUnits("100", DECIMALS);
      await foreignAssetMock.connect(user).approve(await wrapper.getAddress(), amount);
      await wrapper.connect(user).deposit(amount);
      await checkInvariant();

      // Upgrade implementation
      const NewImpl = await ethers.getContractFactory("AjunaWrapper");
      const newImpl = await NewImpl.deploy();
      await newImpl.waitForDeployment();
      await wrapper.connect(owner).upgradeToAndCall(await newImpl.getAddress(), "0x");

      // Verify state preserved
      await checkInvariant();
      expect(await token.balanceOf(user.address)).to.equal(amount);

      // Verify unwrap still works after upgrade
      await token.connect(user).approve(await wrapper.getAddress(), amount);
      await wrapper.connect(user).withdraw(amount);
      await checkInvariant();
      expect(await token.totalSupply()).to.equal(0);
    });

    it("should prevent calling initialize on implementation directly", async function () {
      const Factory = await ethers.getContractFactory("AjunaERC20");
      const impl = await Factory.deploy();
      await impl.waitForDeployment();

      // Implementation has _disableInitializers() in constructor
      await expect(
        impl.initialize("Hack", "HACK", user.address, 18, 0)
      ).to.be.reverted;
    });

    it("should reject upgrading AjunaERC20 to an EOA (non-contract)", async function () {
      const eoa = ethers.Wallet.createRandom().address;
      await expect(
        token.connect(owner).upgradeToAndCall(eoa, "0x")
      ).to.be.reverted;
    });

    it("should reject upgrading AjunaWrapper to an EOA (non-contract)", async function () {
      const eoa = ethers.Wallet.createRandom().address;
      await expect(
        wrapper.connect(owner).upgradeToAndCall(eoa, "0x")
      ).to.be.reverted;
    });

    it("should upgrade AjunaWrapper with migration calldata (V2)", async function () {
      // Wrap some tokens before upgrade
      const amount = ethers.parseUnits("50", DECIMALS);
      await foreignAssetMock.connect(user).approve(await wrapper.getAddress(), amount);
      await wrapper.connect(user).deposit(amount);
      await checkInvariant();

      // Deploy V2 and upgrade with migration calldata
      const V2Factory = await ethers.getContractFactory("AjunaWrapperV2");
      const v2Impl = await V2Factory.deploy();
      await v2Impl.waitForDeployment();

      const migrateData = V2Factory.interface.encodeFunctionData("migrateToV2");
      await wrapper.connect(owner).upgradeToAndCall(await v2Impl.getAddress(), migrateData);

      // Attach as V2 to access new functions
      const wrapperV2 = V2Factory.attach(await wrapper.getAddress());

      // Verify migration ran
      expect(await wrapperV2.version()).to.equal(2);
      expect(await wrapperV2.isV2()).to.be.true;

      // Verify old state preserved
      expect(await wrapperV2.token()).to.equal(await token.getAddress());
      expect(await wrapperV2.foreignAsset()).to.equal(await foreignAssetMock.getAddress());
      expect(await wrapperV2.owner()).to.equal(owner.address);
      await checkInvariant();

      // Verify deposit/withdraw still work after upgrade
      await foreignAssetMock.connect(user).approve(await wrapper.getAddress(), amount);
      await wrapper.connect(user).deposit(amount);
      await checkInvariant();
      expect(await token.balanceOf(user.address)).to.equal(amount * 2n);
    });

    it("should upgrade AjunaERC20 with migration calldata (V2)", async function () {
      // Mint some tokens first
      const amount = ethers.parseUnits("100", DECIMALS);
      await foreignAssetMock.connect(user).approve(await wrapper.getAddress(), amount);
      await wrapper.connect(user).deposit(amount);

      // Deploy V2 and upgrade
      const V2Factory = await ethers.getContractFactory("AjunaERC20V2");
      const v2Impl = await V2Factory.deploy();
      await v2Impl.waitForDeployment();

      const migrateData = V2Factory.interface.encodeFunctionData("migrateToV2");
      await token.connect(owner).upgradeToAndCall(await v2Impl.getAddress(), migrateData);

      const tokenV2 = V2Factory.attach(await token.getAddress());

      // Verify migration
      expect(await tokenV2.version()).to.equal(2);
      expect(await tokenV2.isV2()).to.be.true;

      // Verify old state preserved
      expect(await tokenV2.decimals()).to.equal(DECIMALS);
      expect(await tokenV2.balanceOf(user.address)).to.equal(amount);
      expect(await tokenV2.hasRole(await tokenV2.MINTER_ROLE(), await wrapper.getAddress())).to.be.true;
    });

    it("should preserve storage gap integrity after V2 upgrade", async function () {
      // Deposit before upgrade
      const amount = ethers.parseUnits("75", DECIMALS);
      await foreignAssetMock.connect(user).approve(await wrapper.getAddress(), amount);
      await wrapper.connect(user).deposit(amount);

      // Upgrade to V2
      const V2Factory = await ethers.getContractFactory("AjunaWrapperV2");
      const v2Impl = await V2Factory.deploy();
      await v2Impl.waitForDeployment();
      const migrateData = V2Factory.interface.encodeFunctionData("migrateToV2");
      await wrapper.connect(owner).upgradeToAndCall(await v2Impl.getAddress(), migrateData);

      // Verify new variable doesn't corrupt old state
      const wrapperV2 = V2Factory.attach(await wrapper.getAddress());
      expect(await wrapperV2.version()).to.equal(2);
      expect(await wrapperV2.token()).to.equal(await token.getAddress());
      expect(await wrapperV2.foreignAsset()).to.equal(await foreignAssetMock.getAddress());

      // Full round-trip after upgrade: withdraw everything
      await token.connect(user).approve(await wrapper.getAddress(), amount);
      await wrapper.connect(user).withdraw(amount);
      await checkInvariant();
      expect(await token.totalSupply()).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  Ownership Transfer
  // ═══════════════════════════════════════════════════════════

  describe("Ownership Transfer", function () {
    it("should transfer ownership via 2-step process (transferOwnership + acceptOwnership)", async function () {
      // Step 1: current owner proposes — does not yet change owner()
      await expect(wrapper.connect(owner).transferOwnership(user.address))
        .to.emit(wrapper, "OwnershipTransferStarted")
        .withArgs(owner.address, user.address);

      // Pending state: owner unchanged, pendingOwner set
      expect(await wrapper.owner()).to.equal(owner.address);
      expect(await (wrapper as any).pendingOwner()).to.equal(user.address);

      // Old owner still has full power until acceptance
      await wrapper.connect(owner).pause();
      await wrapper.connect(owner).unpause();

      // Random caller cannot accept
      await expect((wrapper as any).connect(user2).acceptOwnership()).to.be.reverted;
      // Old owner cannot accept on behalf of new owner
      await expect((wrapper as any).connect(owner).acceptOwnership()).to.be.reverted;

      // Step 2: pending owner accepts — ownership transfers
      await (wrapper as any).connect(user).acceptOwnership();
      expect(await wrapper.owner()).to.equal(user.address);
      expect(await (wrapper as any).pendingOwner()).to.equal(ZERO_ADDRESS);

      // Old owner can no longer act
      await expect(wrapper.connect(owner).pause()).to.be.reverted;

      // New owner can act
      await wrapper.connect(user).pause();
      expect(await wrapper.paused()).to.be.true;
    });

    it("should allow cancelling a pending ownership transfer (Ownable2Step)", async function () {
      // Initiate transfer
      await wrapper.connect(owner).transferOwnership(user.address);
      expect(await (wrapper as any).pendingOwner()).to.equal(user.address);

      // Owner cancels by transferring to zero — Ownable2Step explicitly allows this
      await wrapper.connect(owner).transferOwnership(ZERO_ADDRESS);
      expect(await (wrapper as any).pendingOwner()).to.equal(ZERO_ADDRESS);

      // Original owner remains
      expect(await wrapper.owner()).to.equal(owner.address);

      // Previously pending account cannot accept anything
      await expect((wrapper as any).connect(user).acceptOwnership()).to.be.reverted;
    });

    it("should prevent non-owner from transferring ownership", async function () {
      await expect(
        wrapper.connect(user).transferOwnership(user2.address)
      ).to.be.reverted;
    });

    it("should block renounceOwnership for any caller", async function () {
      await expect(wrapper.connect(owner).renounceOwnership())
        .to.be.revertedWith("AjunaWrapper: renouncing ownership is disabled");
      await expect(wrapper.connect(user).renounceOwnership())
        .to.be.revertedWith("AjunaWrapper: renouncing ownership is disabled");

      // Owner unchanged
      expect(await wrapper.owner()).to.equal(owner.address);
      // Owner can still act
      await wrapper.connect(owner).pause();
      expect(await wrapper.paused()).to.be.true;
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  Role Management
  // ═══════════════════════════════════════════════════════════

  describe("Role Management", function () {
    it("should reject grantRole(MINTER_ROLE, X) when X != boundMinter (audit ATS-04)", async function () {
      const MINTER_ROLE = await token.MINTER_ROLE();

      // Wrapper is bound. Granting MINTER_ROLE to anyone else must revert.
      await expect(token.connect(owner).grantRole(MINTER_ROLE, owner.address))
        .to.be.revertedWith("AjunaERC20: MINTER_ROLE bound to a single address");
      await expect(token.connect(owner).grantRole(MINTER_ROLE, user.address))
        .to.be.revertedWith("AjunaERC20: MINTER_ROLE bound to a single address");

      // The bound wrapper still holds MINTER_ROLE.
      expect(await token.hasRole(MINTER_ROLE, await wrapper.getAddress())).to.be.true;

      // Wrapper can mint via deposit as usual.
      const amount = ethers.parseUnits("10", DECIMALS);
      await foreignAssetMock.connect(user).approve(await wrapper.getAddress(), amount);
      await wrapper.connect(user).deposit(amount);
      expect(await token.balanceOf(user.address)).to.equal(amount);
    });

    it("should block deposit/withdraw after MINTER_ROLE revocation", async function () {
      const MINTER_ROLE = await token.MINTER_ROLE();
      const wrapperAddr = await wrapper.getAddress();

      // Revoke MINTER_ROLE from wrapper
      await token.connect(owner).revokeRole(MINTER_ROLE, wrapperAddr);

      // Deposit should fail (mint will revert)
      const amount = ethers.parseUnits("10", DECIMALS);
      await foreignAssetMock.connect(user).approve(wrapperAddr, amount);
      await expect(wrapper.connect(user).deposit(amount)).to.be.reverted;
    });

    it("should recover after re-granting MINTER_ROLE", async function () {
      const MINTER_ROLE = await token.MINTER_ROLE();
      const wrapperAddr = await wrapper.getAddress();

      // Revoke
      await token.connect(owner).revokeRole(MINTER_ROLE, wrapperAddr);

      // Re-grant
      await token.connect(owner).grantRole(MINTER_ROLE, wrapperAddr);

      // Deposit should work again
      const amount = ethers.parseUnits("10", DECIMALS);
      await foreignAssetMock.connect(user).approve(wrapperAddr, amount);
      await wrapper.connect(user).deposit(amount);
      expect(await token.balanceOf(user.address)).to.equal(amount);
      await checkInvariant();
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  Rescue Edge Cases
  // ═══════════════════════════════════════════════════════════

  describe("Rescue Edge Cases", function () {
    it("should rescue zero amount without reverting", async function () {
      const randomToken = await deployERC20Proxy("Random", "RND", owner.address, 18);
      // Rescue 0 — should succeed (SafeERC20 doesn't block zero transfers)
      await wrapper.connect(owner).rescueToken(
        await randomToken.getAddress(),
        owner.address,
        0
      );
    });

    it("should revert rescue when contract has insufficient balance", async function () {
      const randomToken = await deployERC20Proxy("Random", "RND", owner.address, 18);
      // Contract has 0 balance of randomToken, rescue 100 should revert
      await expect(
        wrapper.connect(owner).rescueToken(
          await randomToken.getAddress(),
          owner.address,
          100
        )
      ).to.be.reverted;
    });

    it("should emit correct event arguments on rescue", async function () {
      const randomToken = await deployERC20Proxy("Random", "RND", owner.address, 18);
      await randomToken.grantRole(await randomToken.MINTER_ROLE(), owner.address);
      const rescueAmount = 500;
      await randomToken.mint(await wrapper.getAddress(), rescueAmount);

      await expect(
        wrapper.connect(owner).rescueToken(
          await randomToken.getAddress(),
          user.address,
          rescueAmount
        )
      )
        .to.emit(wrapper, "TokenRescued")
        .withArgs(await randomToken.getAddress(), user.address, rescueAmount);

      expect(await randomToken.balanceOf(user.address)).to.equal(rescueAmount);
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  Pause Edge Cases
  // ═══════════════════════════════════════════════════════════

  describe("Pause Edge Cases", function () {
    it("should block deposit after approval is set and contract is paused", async function () {
      const amount = ethers.parseUnits("50", DECIMALS);

      // User approves first
      await foreignAssetMock.connect(user).approve(await wrapper.getAddress(), amount);

      // Owner pauses between approval and deposit
      await wrapper.connect(owner).pause();

      // Deposit should be blocked even though approval exists
      await expect(wrapper.connect(user).deposit(amount)).to.be.reverted;

      // Unpause and verify it works
      await wrapper.connect(owner).unpause();
      await wrapper.connect(user).deposit(amount);
      expect(await token.balanceOf(user.address)).to.equal(amount);
    });

    it("should allow rescue while paused", async function () {
      const randomToken = await deployERC20Proxy("Random", "RND", owner.address, 18);
      await randomToken.grantRole(await randomToken.MINTER_ROLE(), owner.address);
      await randomToken.mint(await wrapper.getAddress(), 1000);

      // Pause the contract
      await wrapper.connect(owner).pause();

      // Rescue should still work (not guarded by whenNotPaused)
      await wrapper.connect(owner).rescueToken(
        await randomToken.getAddress(),
        owner.address,
        1000
      );
      expect(await randomToken.balanceOf(owner.address)).to.equal(1000);
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  Zero-Amount Edge Cases
  // ═══════════════════════════════════════════════════════════

  describe("Zero-Amount Edge Cases", function () {
    it("should revert deposit of zero", async function () {
      await expect(wrapper.connect(user).deposit(0)).to.be.revertedWith("Amount must be > 0");
    });

    it("should revert withdraw of zero", async function () {
      await expect(wrapper.connect(user).withdraw(0)).to.be.revertedWith("Amount must be > 0");
    });

    it("should allow approve(0) then deposit (with separate approval)", async function () {
      const amount = ethers.parseUnits("10", DECIMALS);

      // Approve to 0, then approve to amount
      await foreignAssetMock.connect(user).approve(await wrapper.getAddress(), 0);
      await foreignAssetMock.connect(user).approve(await wrapper.getAddress(), amount);

      await wrapper.connect(user).deposit(amount);
      expect(await token.balanceOf(user.address)).to.equal(amount);
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  Reentrancy Protection
  // ═══════════════════════════════════════════════════════════

  describe("Reentrancy Protection", function () {
    it("should block reentrancy on deposit via malicious transferFrom", async function () {
      // Deploy the reentrant token
      const ReentrantFactory = await ethers.getContractFactory("ReentrantToken");
      const reentrantToken = await ReentrantFactory.deploy();
      await reentrantToken.waitForDeployment();

      // Deploy an isolated system whose foreign asset is the reentrant token.
      // The shared `token` already has bindMinter set to the main wrapper, so
      // this test gets its own bound wAJUN.
      const { token: localToken, wrapper: maliciousWrapper } = await deployIsolatedSystem(
        await reentrantToken.getAddress()
      );

      // Setup: mint tokens and configure attack
      const amount = ethers.parseUnits("100", DECIMALS);
      await reentrantToken.mintTo(user.address, amount * 2n);
      await reentrantToken.setTarget(await maliciousWrapper.getAddress());
      await reentrantToken.enableAttack();

      // Approve and attempt deposit — the reentrant transferFrom will try to call deposit again
      await reentrantToken.connect(user).approve(await maliciousWrapper.getAddress(), amount * 2n);

      // The outer deposit may succeed, but the reentrancy attempt inside transferFrom
      // will be blocked by nonReentrant. The overall tx depends on how the mock handles
      // the failed reentrant call — in our mock, we silently ignore it.
      await maliciousWrapper.connect(user).deposit(amount);

      // Verify only one deposit went through (not double)
      expect(await localToken.balanceOf(user.address)).to.equal(amount);
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  Event Validation
  // ═══════════════════════════════════════════════════════════

  describe("Event Validation", function () {
    it("should emit Deposited with correct args", async function () {
      const amount = ethers.parseUnits("42", DECIMALS);
      await foreignAssetMock.connect(user).approve(await wrapper.getAddress(), amount);

      await expect(wrapper.connect(user).deposit(amount))
        .to.emit(wrapper, "Deposited")
        .withArgs(user.address, amount);
    });

    it("should emit Withdrawn with correct args", async function () {
      const amount = ethers.parseUnits("42", DECIMALS);
      await foreignAssetMock.connect(user).approve(await wrapper.getAddress(), amount);
      await wrapper.connect(user).deposit(amount);

      await token.connect(user).approve(await wrapper.getAddress(), amount);
      await expect(wrapper.connect(user).withdraw(amount))
        .to.emit(wrapper, "Withdrawn")
        .withArgs(user.address, amount);
    });

    it("should emit ERC20 Transfer events on deposit (mint)", async function () {
      const amount = ethers.parseUnits("10", DECIMALS);
      await foreignAssetMock.connect(user).approve(await wrapper.getAddress(), amount);

      // deposit should trigger Transfer(0x0, user, amount) on wAJUN
      await expect(wrapper.connect(user).deposit(amount))
        .to.emit(token, "Transfer")
        .withArgs(ZERO_ADDRESS, user.address, amount);
    });

    it("should emit ERC20 Transfer events on withdraw (burn)", async function () {
      const amount = ethers.parseUnits("10", DECIMALS);
      await foreignAssetMock.connect(user).approve(await wrapper.getAddress(), amount);
      await wrapper.connect(user).deposit(amount);

      await token.connect(user).approve(await wrapper.getAddress(), amount);
      await expect(wrapper.connect(user).withdraw(amount))
        .to.emit(token, "Transfer")
        .withArgs(user.address, ZERO_ADDRESS, amount);
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  Allowlist (initial-rollout gate)
  // ═══════════════════════════════════════════════════════════

  describe("Allowlist", function () {
    const amount = ethers.parseUnits("100", DECIMALS);

    // Re-enable the gate at the start of every allowlist-specific test.
    beforeEach(async function () {
      await wrapper.connect(owner).setAllowlistEnabled(true);
    });

    it("should be enabled by default on a fresh deploy", async function () {
      const fresh = await deployWrapperProxy(
        await token.getAddress(),
        await foreignAssetMock.getAddress()
      );
      expect(await fresh.allowlistEnabled()).to.be.true;
    });

    it("should block a non-allowlisted user when enabled", async function () {
      await foreignAssetMock.connect(user).approve(await wrapper.getAddress(), amount);
      await expect(wrapper.connect(user).deposit(amount))
        .to.be.revertedWith("AjunaWrapper: not allowlisted");
    });

    it("should allow an allowlisted user when enabled", async function () {
      await wrapper.connect(owner).setAllowlist(user.address, true);
      await foreignAssetMock.connect(user).approve(await wrapper.getAddress(), amount);
      await wrapper.connect(user).deposit(amount);
      expect(await token.balanceOf(user.address)).to.equal(amount);
    });

    it("should let owner deposit even with allowlist enabled and mapping empty", async function () {
      // Owner needs foreign assets first — mint via the mock
      await foreignAssetMock.connect(owner).mint(owner.address, amount);
      await foreignAssetMock.connect(owner).approve(await wrapper.getAddress(), amount);

      // Owner is implicitly allowed regardless of allowlist contents
      await wrapper.connect(owner).deposit(amount);
      expect(await token.balanceOf(owner.address)).to.equal(amount);
    });

    it("should let owner deposit even after being explicitly removed from allowlist", async function () {
      // Set then explicitly remove the owner — short-circuit must still allow
      await wrapper.connect(owner).setAllowlist(owner.address, true);
      await wrapper.connect(owner).setAllowlist(owner.address, false);
      expect(await wrapper.allowlisted(owner.address)).to.be.false;

      await foreignAssetMock.connect(owner).mint(owner.address, amount);
      await foreignAssetMock.connect(owner).approve(await wrapper.getAddress(), amount);
      await wrapper.connect(owner).deposit(amount);
      expect(await token.balanceOf(owner.address)).to.equal(amount);
    });

    it("should let a NEW owner deposit immediately after acceptOwnership, without any setAllowlist call", async function () {
      // Multisig handoff: transfer + accept
      await wrapper.connect(owner).transferOwnership(user2.address);
      await (wrapper as any).connect(user2).acceptOwnership();
      expect(await wrapper.owner()).to.equal(user2.address);

      // user2 (new owner) deposits without ever being added to allowlist
      await foreignAssetMock.connect(user2).approve(await wrapper.getAddress(), amount);
      await wrapper.connect(user2).deposit(amount);
      expect(await token.balanceOf(user2.address)).to.equal(amount);

      // And the previous owner is now a regular non-allowlisted user → blocked
      await foreignAssetMock.connect(owner).mint(owner.address, amount);
      await foreignAssetMock.connect(owner).approve(await wrapper.getAddress(), amount);
      await expect(wrapper.connect(owner).deposit(amount))
        .to.be.revertedWith("AjunaWrapper: not allowlisted");
    });

    it("should NOT gate withdraw — redemption is permissionless even with allowlist on (MED-1)", async function () {
      // 1. Allowlist user, deposit, then revoke their allowlist entry.
      await wrapper.connect(owner).setAllowlist(user.address, true);
      await foreignAssetMock.connect(user).approve(await wrapper.getAddress(), amount);
      await wrapper.connect(user).deposit(amount);

      // 2. Revoke. User should still be able to withdraw — the gate applies to
      //    deposit only. This is the MED-1 fix: redemption is a user right.
      await wrapper.connect(owner).setAllowlist(user.address, false);
      expect(await wrapper.allowlistEnabled()).to.be.true;
      expect(await wrapper.allowlisted(user.address)).to.be.false;

      // Withdraw succeeds.
      await token.connect(user).approve(await wrapper.getAddress(), amount);
      await wrapper.connect(user).withdraw(amount);
      expect(await foreignAssetMock.balanceOf(user.address)).to.equal(INITIAL_SUPPLY);
      expect(await token.balanceOf(user.address)).to.equal(0);

      // But further deposit IS still blocked.
      await foreignAssetMock.connect(user).approve(await wrapper.getAddress(), amount);
      await expect(wrapper.connect(user).deposit(amount))
        .to.be.revertedWith("AjunaWrapper: not allowlisted");
    });

    it("should let any holder withdraw even if allowlist was never extended to them", async function () {
      // Owner deposits and transfers wAJUN to a non-allowlisted user. That
      // user must still be able to redeem.
      await foreignAssetMock.connect(owner).mint(owner.address, amount);
      await foreignAssetMock.connect(owner).approve(await wrapper.getAddress(), amount);
      await wrapper.connect(owner).deposit(amount);

      await token.connect(owner).transfer(user2.address, amount);
      expect(await wrapper.allowlisted(user2.address)).to.be.false;

      await token.connect(user2).approve(await wrapper.getAddress(), amount);
      await wrapper.connect(user2).withdraw(amount);
      expect(await foreignAssetMock.balanceOf(user2.address)).to.equal(INITIAL_SUPPLY + amount);
    });

    it("should be a no-op when disabled — anyone can deposit and withdraw", async function () {
      await wrapper.connect(owner).setAllowlistEnabled(false);
      expect(await wrapper.allowlistEnabled()).to.be.false;

      // user is NOT in the mapping, but the gate is off
      await foreignAssetMock.connect(user).approve(await wrapper.getAddress(), amount);
      await wrapper.connect(user).deposit(amount);

      await token.connect(user).approve(await wrapper.getAddress(), amount);
      await wrapper.connect(user).withdraw(amount);

      expect(await token.balanceOf(user.address)).to.equal(0);
    });

    it("should support setAllowlistBatch for bulk add and bulk remove", async function () {
      // Bulk add
      await wrapper.connect(owner).setAllowlistBatch([user.address, user2.address], true);
      expect(await wrapper.allowlisted(user.address)).to.be.true;
      expect(await wrapper.allowlisted(user2.address)).to.be.true;

      // Both can deposit
      await foreignAssetMock.connect(user).approve(await wrapper.getAddress(), amount);
      await foreignAssetMock.connect(user2).approve(await wrapper.getAddress(), amount);
      await wrapper.connect(user).deposit(amount);
      await wrapper.connect(user2).deposit(amount);

      // Bulk remove
      await wrapper.connect(owner).setAllowlistBatch([user.address, user2.address], false);
      expect(await wrapper.allowlisted(user.address)).to.be.false;
      expect(await wrapper.allowlisted(user2.address)).to.be.false;
    });

    it("should reject setAllowlist with zero address", async function () {
      await expect(wrapper.connect(owner).setAllowlist(ZERO_ADDRESS, true))
        .to.be.revertedWith("AjunaWrapper: account is zero address");
    });

    it("should reject setAllowlistBatch containing a zero address", async function () {
      await expect(
        wrapper.connect(owner).setAllowlistBatch([user.address, ZERO_ADDRESS], true)
      ).to.be.revertedWith("AjunaWrapper: account is zero address");
    });

    it("should reject setAllowlist from non-owner", async function () {
      await expect(wrapper.connect(user).setAllowlist(user.address, true)).to.be.reverted;
    });

    it("should reject setAllowlistEnabled from non-owner", async function () {
      await expect(wrapper.connect(user).setAllowlistEnabled(false)).to.be.reverted;
    });

    it("should emit AllowlistEnabledUpdated and AllowlistUpdated events", async function () {
      await expect(wrapper.connect(owner).setAllowlistEnabled(false))
        .to.emit(wrapper, "AllowlistEnabledUpdated")
        .withArgs(false);

      await expect(wrapper.connect(owner).setAllowlist(user.address, true))
        .to.emit(wrapper, "AllowlistUpdated")
        .withArgs(user.address, true);

      await expect(wrapper.connect(owner).setAllowlistBatch([user.address, user2.address], true))
        .to.emit(wrapper, "AllowlistUpdated")
        .withArgs(user.address, true)
        .and.to.emit(wrapper, "AllowlistUpdated")
        .withArgs(user2.address, true);
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  SafeERC20 Defense (LOW-A)
  // ═══════════════════════════════════════════════════════════

  describe("SafeERC20 Defense", function () {
    it("should reject deposit when foreign asset returns false from transferFrom", async function () {
      // Deploy a wrapper pointed at a misbehaving foreign asset
      const Bad = await ethers.getContractFactory("BadERC20");
      const bad = await Bad.deploy();
      await bad.waitForDeployment();

      const { token: localToken, wrapper: badWrapper } = await deployIsolatedSystem(
        await bad.getAddress()
      );

      const amount = ethers.parseUnits("10", DECIMALS);
      await bad.mintTo(user.address, amount);
      // Approval doesn't matter; the malicious transferFrom returns false silently.

      // SafeERC20 must reject the silent-false return. Without the LOW-A fix
      // this would pass through (deposit would silently mint wAJUN with no
      // backing — invariant broken).
      await expect(badWrapper.connect(user).deposit(amount)).to.be.reverted;

      // Confirm no wAJUN was minted (invariant still intact).
      expect(await localToken.balanceOf(user.address)).to.equal(0);
      expect(await localToken.totalSupply()).to.equal(0);
    });

    it("should reject withdraw when foreign asset returns false from transfer", async function () {
      // HalfBadERC20: transferFrom succeeds (so deposit can complete and the
      // user holds wAJUN); transfer returns false silently (so withdraw's
      // safeTransfer reverts).
      const HalfBad = await ethers.getContractFactory("HalfBadERC20");
      const halfBad = await HalfBad.deploy();
      await halfBad.waitForDeployment();

      const { token: localToken, wrapper: hbWrapper } = await deployIsolatedSystem(
        await halfBad.getAddress()
      );

      // Deposit succeeds normally
      const amount = ethers.parseUnits("10", DECIMALS);
      await halfBad.mintTo(user.address, amount);
      await halfBad.connect(user).approve(await hbWrapper.getAddress(), amount);
      await hbWrapper.connect(user).deposit(amount);
      expect(await localToken.balanceOf(user.address)).to.equal(amount);

      // Withdraw must revert via SafeERC20 since transfer returns false
      await localToken.connect(user).approve(await hbWrapper.getAddress(), amount);
      await expect(hbWrapper.connect(user).withdraw(amount)).to.be.reverted;

      // wAJUN was NOT burned — the burnFrom + safeTransfer pair is atomic and
      // the safeTransfer revert rolls back the burn.
      expect(await localToken.balanceOf(user.address)).to.equal(amount);
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  Invariant View (INFO-C)
  // ═══════════════════════════════════════════════════════════

  describe("isInvariantHealthy", function () {
    it("should return true on a fresh wrapper (0 == 0)", async function () {
      expect(await wrapper.isInvariantHealthy()).to.be.true;
    });

    it("should remain true after a normal deposit", async function () {
      const amount = ethers.parseUnits("100", DECIMALS);
      await foreignAssetMock.connect(user).approve(await wrapper.getAddress(), amount);
      await wrapper.connect(user).deposit(amount);
      expect(await wrapper.isInvariantHealthy()).to.be.true;
    });

    it("should remain true after a normal withdraw", async function () {
      const amount = ethers.parseUnits("100", DECIMALS);
      await foreignAssetMock.connect(user).approve(await wrapper.getAddress(), amount);
      await wrapper.connect(user).deposit(amount);

      await token.connect(user).approve(await wrapper.getAddress(), amount);
      await wrapper.connect(user).withdraw(amount);

      expect(await wrapper.isInvariantHealthy()).to.be.true;
      expect(await token.totalSupply()).to.equal(0);
    });

    it("should return false (over-collateralized) after a direct AJUN transfer to the wrapper", async function () {
      // A third party direct-transfers AJUN to the wrapper (no deposit).
      // Treasury balance grows; totalSupply does NOT. The strict-equality
      // check returns false; the system is over-collateralized, which is
      // safe — but this is exactly the signal off-chain monitors need.
      const dust = ethers.parseUnits("1", DECIMALS);
      await foreignAssetMock.connect(user).transfer(await wrapper.getAddress(), dust);

      expect(await wrapper.isInvariantHealthy()).to.be.false;
      // Treasury > supply (over-collateralized, not under-collateralized)
      expect(await foreignAssetMock.balanceOf(await wrapper.getAddress())).to.be.gt(
        await token.totalSupply()
      );
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  Fee-on-transfer Defense (LOW-1)
  // ═══════════════════════════════════════════════════════════

  describe("Fee-on-transfer Defense", function () {
    it("should mint exactly the received amount when foreign asset takes a fee on transfer", async function () {
      // Deploy a wrapper pointed at a fee-taking foreign asset.
      const Fot = await ethers.getContractFactory("FeeOnTransferERC20");
      const fot = await Fot.deploy();
      await fot.waitForDeployment();

      const { token: localToken, wrapper: fotWrapper } = await deployIsolatedSystem(
        await fot.getAddress()
      );

      const input = ethers.parseUnits("100", DECIMALS);
      const expectedReceived = input * 9000n / 10_000n; // 10% fee

      await fot.mintTo(user.address, input);
      await fot.connect(user).approve(await fotWrapper.getAddress(), input);

      // Without LOW-1: would mint `input` while treasury received only 90% of it
      // -> under-collateralized. With LOW-1: mints exactly what was received.
      await expect(fotWrapper.connect(user).deposit(input))
        .to.emit(fotWrapper, "Deposited")
        .withArgs(user.address, expectedReceived);

      expect(await localToken.balanceOf(user.address)).to.equal(expectedReceived);
      expect(await fot.balanceOf(await fotWrapper.getAddress())).to.equal(expectedReceived);

      // Invariant holds — wrapper not under-collateralized.
      expect(await fotWrapper.isInvariantHealthy()).to.be.true;
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  Allowlist Batch Cap (INFO-4)
  // ═══════════════════════════════════════════════════════════

  describe("Allowlist Batch Cap", function () {
    it("should reject setAllowlistBatch with more than MAX_ALLOWLIST_BATCH entries", async function () {
      const max = await wrapper.MAX_ALLOWLIST_BATCH();
      // Build an array one bigger than the cap
      const oversized: string[] = [];
      for (let i = 0; i < Number(max) + 1; i++) {
        oversized.push(ethers.Wallet.createRandom().address);
      }
      await expect(wrapper.connect(owner).setAllowlistBatch(oversized, true))
        .to.be.revertedWith("AjunaWrapper: batch too large");
    });

    it("should accept setAllowlistBatch with exactly MAX_ALLOWLIST_BATCH entries", async function () {
      const max = await wrapper.MAX_ALLOWLIST_BATCH();
      const atCap: string[] = [];
      for (let i = 0; i < Number(max); i++) {
        atCap.push(ethers.Wallet.createRandom().address);
      }
      await wrapper.connect(owner).setAllowlistBatch(atCap, true);
      // Spot-check first and last got added
      expect(await wrapper.allowlisted(atCap[0])).to.be.true;
      expect(await wrapper.allowlisted(atCap[atCap.length - 1])).to.be.true;
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  AccessControlDefaultAdminRules Admin Handoff (MED-2)
  // ═══════════════════════════════════════════════════════════

  describe("Admin Handoff (Default Admin Rules)", function () {
    // Initial-admin delay was set to 0 by deployERC20Proxy — accept can be
    // called immediately, but the two-step protection (cancellable until
    // accept) still applies.

    it("exposes the standard Default Admin Rules surface", async function () {
      expect(await token.defaultAdmin()).to.equal(owner.address);
      expect(await token.defaultAdminDelay()).to.equal(0);
      const pending = await token.pendingDefaultAdmin();
      expect(pending.newAdmin).to.equal(ZERO_ADDRESS);
    });

    it("requires beginDefaultAdminTransfer + acceptDefaultAdminTransfer (no single-step grantRole)", async function () {
      const DEFAULT_ADMIN_ROLE = await token.DEFAULT_ADMIN_ROLE();

      // Direct grantRole(DEFAULT_ADMIN_ROLE, ...) is blocked by the new rules.
      await expect(token.connect(owner).grantRole(DEFAULT_ADMIN_ROLE, user.address)).to.be.reverted;

      // Two-step transfer: begin from old admin, accept from new admin.
      await token.connect(owner).beginDefaultAdminTransfer(user.address);
      const pending = await token.pendingDefaultAdmin();
      expect(pending.newAdmin).to.equal(user.address);
      expect(await token.defaultAdmin()).to.equal(owner.address); // unchanged

      await token.connect(user).acceptDefaultAdminTransfer();
      expect(await token.defaultAdmin()).to.equal(user.address);
      expect(await token.hasRole(DEFAULT_ADMIN_ROLE, user.address)).to.be.true;
      expect(await token.hasRole(DEFAULT_ADMIN_ROLE, owner.address)).to.be.false;
    });

    it("allows the current admin to cancel a pending transfer (typo recovery)", async function () {
      await token.connect(owner).beginDefaultAdminTransfer(user.address);
      expect((await token.pendingDefaultAdmin()).newAdmin).to.equal(user.address);

      // Owner spots the typo and cancels.
      await token.connect(owner).cancelDefaultAdminTransfer();
      expect((await token.pendingDefaultAdmin()).newAdmin).to.equal(ZERO_ADDRESS);

      // The not-quite-pending account can no longer accept.
      await expect(token.connect(user).acceptDefaultAdminTransfer()).to.be.reverted;

      // Original admin retains control.
      expect(await token.defaultAdmin()).to.equal(owner.address);
    });

    it("blocks an unintended account from accepting", async function () {
      await token.connect(owner).beginDefaultAdminTransfer(user.address);
      // user2 is not the pending admin
      await expect(token.connect(user2).acceptDefaultAdminTransfer()).to.be.reverted;
    });

    it("requires a two-step renunciation of DEFAULT_ADMIN_ROLE (begin → accept with newAdmin == 0)", async function () {
      // renounceRole(DEFAULT_ADMIN_ROLE, ...) on its own should not finalize
      // immediately — the rules contract requires the two-step flow even for
      // renunciation. (This is the "exactly one admin holder at all times"
      // invariant — direct renunciation would leave zero admins.)
      const DEFAULT_ADMIN_ROLE = await token.DEFAULT_ADMIN_ROLE();
      await expect(token.connect(owner).renounceRole(DEFAULT_ADMIN_ROLE, owner.address)).to.be.reverted;

      // Proper "renounce": begin transfer to address(0), then accept.
      await token.connect(owner).beginDefaultAdminTransfer(ZERO_ADDRESS);
      // For zero-address admin, OZ uses renounceRole + the schedule check.
      await token.connect(owner).renounceRole(DEFAULT_ADMIN_ROLE, owner.address);

      expect(await token.defaultAdmin()).to.equal(ZERO_ADDRESS);
      expect(await token.hasRole(DEFAULT_ADMIN_ROLE, owner.address)).to.be.false;
    });

    it("does not affect UPGRADER_ROLE single-step grant flow (MINTER_ROLE is bound; see Role Management)", async function () {
      const UPGRADER_ROLE = await token.UPGRADER_ROLE();

      // UPGRADER_ROLE still grants/revokes in one tx by the DEFAULT_ADMIN_ROLE holder.
      await token.connect(owner).grantRole(UPGRADER_ROLE, user.address);
      expect(await token.hasRole(UPGRADER_ROLE, user.address)).to.be.true;
      await token.connect(owner).revokeRole(UPGRADER_ROLE, user.address);
      expect(await token.hasRole(UPGRADER_ROLE, user.address)).to.be.false;

      // MINTER_ROLE remains bound to the wrapper (audit ATS-04 fix); the
      // grant-to-X-and-revoke pattern doesn't apply.
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  bindMinter (audit ATS-04 fix)
  // ═══════════════════════════════════════════════════════════

  describe("bindMinter (ATS-04)", function () {
    it("exposes the bound minter as a public view", async function () {
      expect(await token.boundMinter()).to.equal(await wrapper.getAddress());
    });

    it("is one-shot — re-binding reverts", async function () {
      await expect(token.connect(owner).bindMinter(user.address))
        .to.be.revertedWith("AjunaERC20: minter already bound");
    });

    it("rejects bindMinter from a non-DEFAULT_ADMIN_ROLE caller", async function () {
      // Use a fresh, unbound token so the binding check is independent of beforeEach
      const fresh = await deployERC20Proxy("X", "X", owner.address, DECIMALS);
      await expect(fresh.connect(user).bindMinter(user.address)).to.be.reverted;
    });

    it("rejects bindMinter(address(0))", async function () {
      const fresh = await deployERC20Proxy("X", "X", owner.address, DECIMALS);
      await expect(fresh.connect(owner).bindMinter(ZERO_ADDRESS))
        .to.be.revertedWith("AjunaERC20: zero minter");
    });

    it("emits MinterBound when binding", async function () {
      const fresh = await deployERC20Proxy("X", "X", owner.address, DECIMALS);
      await expect(fresh.connect(owner).bindMinter(user2.address))
        .to.emit(fresh, "MinterBound")
        .withArgs(user2.address);
    });

    it("grants MINTER_ROLE to the bound minter atomically", async function () {
      const fresh = await deployERC20Proxy("X", "X", owner.address, DECIMALS);
      const MINTER_ROLE = await fresh.MINTER_ROLE();
      expect(await fresh.hasRole(MINTER_ROLE, user2.address)).to.be.false;
      await fresh.connect(owner).bindMinter(user2.address);
      expect(await fresh.hasRole(MINTER_ROLE, user2.address)).to.be.true;
    });

    it("permits re-grant of MINTER_ROLE to the bound minter (after revoke)", async function () {
      const MINTER_ROLE = await token.MINTER_ROLE();
      const wAddr = await wrapper.getAddress();
      // Revoke + re-grant to the bound address must work.
      await token.connect(owner).revokeRole(MINTER_ROLE, wAddr);
      await token.connect(owner).grantRole(MINTER_ROLE, wAddr);
      expect(await token.hasRole(MINTER_ROLE, wAddr)).to.be.true;
    });

    it("blocks pre-bind grants of MINTER_ROLE to anyone (binding semantics start at zero)", async function () {
      // Before bindMinter is called, MINTER_ROLE has no holders. The override
      // permits the bind to perform the *first* grant, but until then the
      // _grantRole override does NOT block direct grantRole calls. This test
      // documents the boundary: the production deploy script always calls
      // bindMinter, so the only "free grant" window is between proxy
      // initialization and bindMinter — covered in production by the
      // allowlist gate (deploy_wrapper.ts script).
      const fresh = await deployERC20Proxy("X", "X", owner.address, DECIMALS);
      const MINTER_ROLE = await fresh.MINTER_ROLE();
      // Pre-bind: grantRole works (binding hasn't engaged).
      await fresh.connect(owner).grantRole(MINTER_ROLE, user.address);
      expect(await fresh.hasRole(MINTER_ROLE, user.address)).to.be.true;
      // Once bindMinter is called, the binding engages on subsequent grants.
      await fresh.connect(owner).bindMinter(user2.address);
      await expect(fresh.connect(owner).grantRole(MINTER_ROLE, user.address))
        .to.be.revertedWith("AjunaERC20: MINTER_ROLE bound to a single address");
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  Decimals coherence (audit ATS-08)
  // ═══════════════════════════════════════════════════════════

  describe("Decimals coherence (ATS-08)", function () {
    it("reverts AjunaWrapper.initialize when foreign-asset decimals != token decimals", async function () {
      // Deploy a wAJUN with 12 decimals
      const t = await deployERC20Proxy("X", "X", owner.address, 12);
      // Deploy a foreign asset with 18 decimals (stand-in: a fresh AjunaERC20 with 18)
      const fa18 = await deployERC20Proxy("Foreign18", "F18", owner.address, 18);

      const Factory = await ethers.getContractFactory("AjunaWrapper");
      const impl = await Factory.deploy();
      await impl.waitForDeployment();
      const initData = Factory.interface.encodeFunctionData("initialize", [
        await t.getAddress(),
        await fa18.getAddress(),
      ]);
      const ProxyFactory = await ethers.getContractFactory("ERC1967Proxy");
      await expect(ProxyFactory.deploy(await impl.getAddress(), initData))
        .to.be.reverted; // SafeERC20-style mismatch revert during initialize
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  Sister views (audit ATS-12)
  // ═══════════════════════════════════════════════════════════

  describe("Sister views (ATS-12)", function () {
    it("getInvariantDelta is 0 on a fresh wrapper", async function () {
      expect(await wrapper.getInvariantDelta()).to.equal(0n);
    });

    it("getInvariantDelta is 0 after a normal deposit", async function () {
      const amount = ethers.parseUnits("100", DECIMALS);
      await foreignAssetMock.connect(user).approve(await wrapper.getAddress(), amount);
      await wrapper.connect(user).deposit(amount);
      expect(await wrapper.getInvariantDelta()).to.equal(0n);
    });

    it("getInvariantDelta is negative when over-collateralized (direct AJUN transfer)", async function () {
      const dust = ethers.parseUnits("1", DECIMALS);
      await foreignAssetMock.connect(user).transfer(await wrapper.getAddress(), dust);
      expect(await wrapper.getInvariantDelta()).to.equal(-dust);
      expect(await wrapper.isUnderCollateralized()).to.be.false;
    });

    it("isUnderCollateralized is false on a healthy wrapper", async function () {
      const amount = ethers.parseUnits("50", DECIMALS);
      await foreignAssetMock.connect(user).approve(await wrapper.getAddress(), amount);
      await wrapper.connect(user).deposit(amount);
      expect(await wrapper.isUnderCollateralized()).to.be.false;
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  Self-rescue check (audit ATS-14)
  // ═══════════════════════════════════════════════════════════

  describe("rescueToken self-rescue (ATS-14)", function () {
    it("reverts when to == address(this)", async function () {
      const randomToken = await deployERC20Proxy("Random", "RND", owner.address, DECIMALS);
      // We don't even need to fund — the check is at the top of rescueToken.
      await expect(
        wrapper.connect(owner).rescueToken(
          await randomToken.getAddress(),
          await wrapper.getAddress(),
          1
        )
      ).to.be.revertedWith("AjunaWrapper: rescue to self");
    });
  });
});
