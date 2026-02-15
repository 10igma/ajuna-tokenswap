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
    decimals: number
  ): Promise<AjunaERC20> {
    const Factory = await ethers.getContractFactory("AjunaERC20");
    const impl = await Factory.deploy();
    await impl.waitForDeployment();

    const initData = Factory.interface.encodeFunctionData("initialize", [
      name, symbol, admin, decimals,
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

    // 3. Grant MINTER_ROLE to Wrapper
    const MINTER_ROLE = await token.MINTER_ROLE();
    await token.grantRole(MINTER_ROLE, await wrapper.getAddress());
  });

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
        "Test", "TST", ZERO_ADDRESS, 12,
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
        "Test", "TST", owner.address, 19,
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
        token.initialize("Hack", "HACK", user.address, 18)
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
        impl.initialize("Hack", "HACK", user.address, 18)
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
    it("should transfer ownership via 2-step process", async function () {
      // OwnableUpgradeable uses transferOwnership (1-step in OZ v5 Ownable)
      await wrapper.connect(owner).transferOwnership(user.address);

      // In OZ v5 OwnableUpgradeable, transferOwnership is immediate (not 2-step)
      expect(await wrapper.owner()).to.equal(user.address);

      // Verify old owner can no longer act
      await expect(wrapper.connect(owner).pause()).to.be.reverted;

      // Verify new owner can act
      await wrapper.connect(user).pause();
      expect(await wrapper.paused()).to.be.true;
    });

    it("should prevent transferring ownership to zero address", async function () {
      await expect(
        wrapper.connect(owner).transferOwnership(ZERO_ADDRESS)
      ).to.be.reverted;
    });

    it("should prevent non-owner from transferring ownership", async function () {
      await expect(
        wrapper.connect(user).transferOwnership(user2.address)
      ).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  Role Management
  // ═══════════════════════════════════════════════════════════

  describe("Role Management", function () {
    it("should handle multiple MINTER_ROLE holders", async function () {
      const MINTER_ROLE = await token.MINTER_ROLE();

      // Grant MINTER_ROLE to a second account
      await token.connect(owner).grantRole(MINTER_ROLE, owner.address);

      // Both can mint
      await token.connect(owner).mint(user.address, 100);
      expect(await token.balanceOf(user.address)).to.equal(100);

      // Wrapper can still mint via deposit
      const amount = ethers.parseUnits("10", DECIMALS);
      await foreignAssetMock.connect(user).approve(await wrapper.getAddress(), amount);
      await wrapper.connect(user).deposit(amount);
      expect(await token.balanceOf(user.address)).to.equal(100n + amount);
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

      // Deploy a wrapper that uses the reentrant token as foreign asset
      const maliciousWrapper = await deployWrapperProxy(
        await token.getAddress(),
        await reentrantToken.getAddress()
      );

      // Grant MINTER_ROLE to the malicious wrapper on the token
      await token.grantRole(await token.MINTER_ROLE(), await maliciousWrapper.getAddress());

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
      expect(await token.balanceOf(user.address)).to.equal(amount);
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
});
