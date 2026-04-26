// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./AjunaERC20.sol";
import "./interfaces/IERC20Precompile.sol";

/**
 * @title AjunaWrapper
 * @notice Treasury contract that wraps AJUN Foreign Assets into ERC20 wAJUN tokens and vice-versa.
 * @dev UUPS-upgradeable. Implements the Mint-and-Lock pattern:
 *      - deposit(): user locks Foreign AJUN → treasury mints wAJUN
 *      - withdraw(): user burns wAJUN (via approval) → treasury releases Foreign AJUN
 *
 *      Invariant: token.totalSupply() == foreignAsset.balanceOf(address(this))
 *
 *      Security features:
 *      - ReentrancyGuard on all state-changing user functions
 *      - Pausable circuit breaker (owner-only)
 *      - Rescue function for accidentally sent tokens (cannot rescue the locked foreign asset)
 *      - foreignAsset address set once in initialize(); change via UUPS upgrade if needed
 *      - UUPS upgradeability for bug-fix deployments (owner-only)
 */
contract AjunaWrapper is Initializable, Ownable2StepUpgradeable, ReentrancyGuard, PausableUpgradeable, UUPSUpgradeable {
    using SafeERC20 for IERC20;

    /// @notice The wrapped ERC20 token (wAJUN) managed by this treasury.
    AjunaERC20 public token;

    /// @notice The Foreign Asset precompile (AJUN). Set once during initialization;
    ///         change via UUPS upgrade if the precompile address ever changes.
    IERC20Precompile public foreignAsset;

    /// @notice Emitted when a user wraps Foreign AJUN into wAJUN.
    event Deposited(address indexed user, uint256 amount);
    /// @notice Emitted when a user unwraps wAJUN back into Foreign AJUN.
    event Withdrawn(address indexed user, uint256 amount);
    /// @notice Emitted when the owner rescues accidentally sent tokens.
    event TokenRescued(address indexed tokenAddress, address indexed to, uint256 amount);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initializes the wrapper treasury (called once via proxy).
     * @param _token                  Address of the deployed AjunaERC20 proxy.
     * @param _foreignAssetPrecompile Address of the Foreign Asset precompile on AssetHub.
     */
    function initialize(
        address _token,
        address _foreignAssetPrecompile
    ) public initializer {
        require(_token != address(0), "AjunaWrapper: token is zero address");
        require(_foreignAssetPrecompile != address(0), "AjunaWrapper: precompile is zero address");
        __Ownable_init(msg.sender);
        __Ownable2Step_init();
        __Pausable_init();
        token = AjunaERC20(_token);
        foreignAsset = IERC20Precompile(_foreignAssetPrecompile);
    }

    // ──────────────────────────────────────────────
    //  Core: Wrap / Unwrap
    // ──────────────────────────────────────────────

    /**
     * @notice Wraps Foreign AJUN into ERC20 wAJUN.
     * @dev The caller must have approved this contract on the Foreign Asset precompile beforehand.
     *      Flow: foreignAsset.transferFrom(user → treasury) → token.mint(user)
     * @param amount Amount of Foreign AJUN to wrap (in smallest unit).
     */
    function deposit(uint256 amount) external nonReentrant whenNotPaused {
        require(amount > 0, "Amount must be > 0");

        // 1. Pull Foreign Assets from user into treasury
        bool success = foreignAsset.transferFrom(
            msg.sender,
            address(this),
            amount
        );
        require(success, "Foreign Asset transfer failed. Check allowance?");

        // 2. Mint equivalent wAJUN to user
        token.mint(msg.sender, amount);

        emit Deposited(msg.sender, amount);
    }

    /**
     * @notice Unwraps ERC20 wAJUN back into Foreign AJUN.
     * @dev The caller must have approved this contract on the wAJUN ERC20 token beforehand
     *      (standard burnFrom pattern).
     *      Flow: token.burnFrom(user) → foreignAsset.transfer(treasury → user)
     * @param amount Amount of wAJUN to unwrap (in smallest unit).
     */
    function withdraw(uint256 amount) external nonReentrant whenNotPaused {
        require(amount > 0, "Amount must be > 0");
        require(
            token.balanceOf(msg.sender) >= amount,
            "Insufficient ERC20 balance"
        );

        // 1. Burn user's wAJUN (requires prior ERC20 approval to this contract)
        token.burnFrom(msg.sender, amount);

        // 2. Release Foreign Assets from treasury back to user
        bool success = foreignAsset.transfer(msg.sender, amount);
        require(success, "Foreign Asset return transfer failed");

        emit Withdrawn(msg.sender, amount);
    }

    // ──────────────────────────────────────────────
    //  Admin: Pause / Unpause
    // ──────────────────────────────────────────────

    /// @notice Pauses all deposit and withdraw operations. Owner-only emergency circuit breaker.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Unpauses deposit and withdraw operations.
    function unpause() external onlyOwner {
        _unpause();
    }

    // ──────────────────────────────────────────────
    //  Admin: Rescue Accidentally Sent Tokens
    // ──────────────────────────────────────────────

    /**
     * @notice Rescues ERC20 tokens accidentally sent to this contract.
     * @dev Cannot be used to withdraw the locked Foreign Asset — that would break the 1:1 backing.
     * @param tokenAddress Address of the token to rescue.
     * @param to           Recipient of the rescued tokens.
     * @param amount       Amount to rescue.
     */
    function rescueToken(address tokenAddress, address to, uint256 amount) external onlyOwner {
        require(tokenAddress != address(foreignAsset), "Cannot rescue locked foreign asset");
        require(tokenAddress != address(token), "Cannot rescue wAJUN token");
        require(to != address(0), "AjunaWrapper: rescue to zero address");
        IERC20(tokenAddress).safeTransfer(to, amount);
        emit TokenRescued(tokenAddress, to, amount);
    }

    // ──────────────────────────────────────────────
    //  Ownership Hardening
    // ──────────────────────────────────────────────

    /**
     * @notice Disabled. The wrapper relies on a live owner for pause, rescue, and
     *         upgrade authorization. Renouncing would permanently brick every admin
     *         lever on a treasury that holds user funds.
     * @dev    Use the two-step transferOwnership / acceptOwnership flow inherited
     *         from Ownable2StepUpgradeable to hand off control to a multisig.
     */
    function renounceOwnership() public pure override {
        revert("AjunaWrapper: renouncing ownership is disabled");
    }

    // ──────────────────────────────────────────────
    //  Upgrade Authorization
    // ──────────────────────────────────────────────

    /**
     * @dev Restricts contract upgrades to the owner.
     */
    function _authorizeUpgrade(address newImplementation) internal view override onlyOwner {
        require(newImplementation.code.length > 0, "AjunaWrapper: implementation not a contract");
    }

    /**
     * @dev Reserved storage gap for future base contract upgrades.
     */
    uint256[48] private __gap;
}
