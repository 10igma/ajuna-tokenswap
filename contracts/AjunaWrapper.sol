// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
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
contract AjunaWrapper is Initializable, Ownable2StepUpgradeable, PausableUpgradeable, UUPSUpgradeable {
    using SafeERC20 for IERC20;

    /// @notice The wrapped ERC20 token (wAJUN) managed by this treasury.
    AjunaERC20 public token;

    /// @notice The Foreign Asset precompile (AJUN). Set once during initialization;
    ///         change via UUPS upgrade if the precompile address ever changes.
    IERC20Precompile public foreignAsset;

    /// @notice Whether the allowlist gate is enforced on `deposit`.
    ///         When `true`, only `owner()` and addresses in `allowlisted` may
    ///         deposit. `withdraw` is **never** gated by the allowlist —
    ///         redemption is a user right and cannot be revoked by the owner.
    ///         Defaults to `true` on `initialize()` for safe staged rollout;
    ///         flip to `false` (single tx) to open the contract to everyone.
    bool public allowlistEnabled;

    /// @notice Per-account allowlist consulted only when `allowlistEnabled == true`.
    ///         The current `owner()` is implicitly always allowed regardless of
    ///         this mapping, so the owner cannot be locked out.
    mapping(address => bool) public allowlisted;

    /// @notice Emitted when a user wraps Foreign AJUN into wAJUN.
    event Deposited(address indexed user, uint256 amount);
    /// @notice Emitted when a user unwraps wAJUN back into Foreign AJUN.
    event Withdrawn(address indexed user, uint256 amount);
    /// @notice Emitted when the owner rescues accidentally sent tokens.
    event TokenRescued(address indexed tokenAddress, address indexed to, uint256 amount);
    /// @notice Emitted when the global allowlist gate is toggled.
    event AllowlistEnabledUpdated(bool enabled);
    /// @notice Emitted when an account's allowlist entry is set or cleared.
    event AllowlistUpdated(address indexed account, bool allowed);

    // ──────────────────────────────────────────────
    //  Inline reentrancy guard (audit ATS-09)
    //
    //  Equivalent to OZ ReentrancyGuard's namespaced storage layout but
    //  inlined here so this contract has no constructor-bearing parent —
    //  satisfies `@openzeppelin/upgrades-core` validate. The slot constant
    //  matches `openzeppelin.storage.ReentrancyGuard` (ERC-7201 namespace),
    //  so storage migration from any historical OZ-ReentrancyGuard-using
    //  build is layout-compatible.
    // ──────────────────────────────────────────────

    bytes32 private constant _REENTRANCY_SLOT =
        0x9b779b17422d0df92223018b32b4d1fa46e071723d6817e2486d003becc55f00;
    uint256 private constant _REENTRANCY_NOT_ENTERED = 1;
    uint256 private constant _REENTRANCY_ENTERED = 2;

    error ReentrancyGuardReentrantCall();

    modifier nonReentrant() {
        bytes32 slot = _REENTRANCY_SLOT;
        uint256 status;
        assembly { status := sload(slot) }
        if (status == _REENTRANCY_ENTERED) revert ReentrancyGuardReentrantCall();
        assembly { sstore(slot, _REENTRANCY_ENTERED) }
        _;
        assembly { sstore(slot, _REENTRANCY_NOT_ENTERED) }
    }

    /// @dev Read-only counterpart for view functions that must not be
    ///      observable mid-non-reentrant call (audit ATS-11).
    modifier nonReentrantView() {
        bytes32 slot = _REENTRANCY_SLOT;
        uint256 status;
        assembly { status := sload(slot) }
        if (status == _REENTRANCY_ENTERED) revert ReentrancyGuardReentrantCall();
        _;
    }

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
        // Initialise the inline reentrancy guard explicitly — addresses
        // audit ATS-09 ("safe by accident because 0 != ENTERED"). With the
        // explicit write, the safety story is "explicitly NOT_ENTERED on
        // first use".
        bytes32 reentrancySlot = _REENTRANCY_SLOT;
        assembly {
            sstore(reentrancySlot, _REENTRANCY_NOT_ENTERED)
        }
        token = AjunaERC20(_token);
        foreignAsset = IERC20Precompile(_foreignAssetPrecompile);
        // Decimals coherence (audit ATS-08): the wrapper accounts in raw
        // units, so a mismatch wouldn't break the 1:1 invariant — but UIs
        // computing `amount * 10**decimals` would mis-display amounts on
        // one side. Catch it at deploy time.
        require(
            foreignAsset.decimals() == token.decimals(),
            "AjunaWrapper: decimals mismatch"
        );
        // Allowlist gate is on by default for staged rollout. The owner is
        // implicitly always allowed (see `onlyAllowedUser`), so no explicit
        // entry is needed at init time.
        allowlistEnabled = true;
        emit AllowlistEnabledUpdated(true);
    }

    // ──────────────────────────────────────────────
    //  Allowlist Gate (initial deploy only — flip off when going public)
    // ──────────────────────────────────────────────

    /**
     * @dev Restricts `deposit` to allowlisted accounts when `allowlistEnabled`
     *      is `true`. The current `owner()` is always allowed, regardless of
     *      `allowlistEnabled` or mapping contents, so the owner can never be
     *      locked out (e.g. for seeding AJUN dust on first-deploy per the
     *      production checklist).
     *
     *      `withdraw` does **not** use this modifier — redemption is a user
     *      right and remains permissionless even while the gate is on. Pause
     *      remains the system-wide circuit breaker if a temporary halt of
     *      redemption is required for an emergency.
     *
     *      When `allowlistEnabled` is `false`, the modifier is a no-op and
     *      the contract behaves like an open ERC20 wrapper.
     */
    modifier onlyAllowedUser() {
        if (allowlistEnabled && msg.sender != owner()) {
            require(allowlisted[msg.sender], "AjunaWrapper: not allowlisted");
        }
        _;
    }

    /// @notice Toggle the allowlist gate. Owner-only.
    function setAllowlistEnabled(bool enabled) external onlyOwner {
        allowlistEnabled = enabled;
        emit AllowlistEnabledUpdated(enabled);
    }

    /// @notice Add or remove a single account from the allowlist. Owner-only.
    function setAllowlist(address account, bool allowed) external onlyOwner {
        require(account != address(0), "AjunaWrapper: account is zero address");
        allowlisted[account] = allowed;
        emit AllowlistUpdated(account, allowed);
    }

    /// @notice Maximum entries per `setAllowlistBatch` call. Caps the
    ///         per-tx weight on `pallet-revive` so a large batch can never
    ///         partially execute then revert against the block weight bound.
    uint256 public constant MAX_ALLOWLIST_BATCH = 100;

    /**
     * @notice Bulk add or remove accounts in a single transaction. Owner-only.
     * @dev    Useful during initial onboarding of a tester cohort. All entries
     *         are set to the same `allowed` value; call twice (true / false)
     *         if you need a mixed update.
     */
    function setAllowlistBatch(address[] calldata accounts, bool allowed) external onlyOwner {
        require(accounts.length <= MAX_ALLOWLIST_BATCH, "AjunaWrapper: batch too large");
        for (uint256 i = 0; i < accounts.length; i++) {
            address account = accounts[i];
            require(account != address(0), "AjunaWrapper: account is zero address");
            allowlisted[account] = allowed;
            emit AllowlistUpdated(account, allowed);
        }
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
    function deposit(uint256 amount) external nonReentrant whenNotPaused onlyAllowedUser {
        require(amount > 0, "Amount must be > 0");

        // 1. Snapshot the wrapper's foreign-asset balance before the pull, so
        //    we mint exactly what the treasury actually received. This is a
        //    no-op against the current AJUN precompile (a standard ERC20
        //    that moves `amount` exactly), but defends against any future
        //    foreign-asset semantics with fee-on-transfer or rebasing.
        IERC20 fa = IERC20(address(foreignAsset));
        uint256 balanceBefore = fa.balanceOf(address(this));

        // 2. Pull Foreign Assets from user into treasury (SafeERC20: reverts on
        //    missing-return-value tokens or tokens that return false silently).
        fa.safeTransferFrom(msg.sender, address(this), amount);

        uint256 received = fa.balanceOf(address(this)) - balanceBefore;
        require(received > 0, "AjunaWrapper: zero received");

        // 3. Mint exactly the received amount of wAJUN. Preserves the 1:1
        //    backing invariant even if `received < amount`.
        token.mint(msg.sender, received);

        emit Deposited(msg.sender, received);
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

        // 2. Release Foreign Assets from treasury back to user (SafeERC20).
        IERC20(address(foreignAsset)).safeTransfer(msg.sender, amount);

        emit Withdrawn(msg.sender, amount);
    }

    // ──────────────────────────────────────────────
    //  Views
    // ──────────────────────────────────────────────

    /**
     * @notice Returns whether the 1:1 backing invariant currently holds:
     *         `wAJUN.totalSupply() == foreignAsset.balanceOf(this)`.
     * @dev    Convenience helper for off-chain monitors and dashboards. The
     *         invariant is the core safety property of the wrapper:
     *           - `true`  => system is exactly backed.
     *           - `false` => either under-backed (alert!) or over-collateralized
     *                        because someone direct-transferred AJUN to the
     *                        wrapper without depositing (safe; cannot be
     *                        withdrawn by users, only the supply locked at
     *                        deposit time can).
     *         Monitors should treat `totalSupply > balanceOf` as the urgent
     *         alarm, since that is the only path that puts user funds at risk.
     */
    function isInvariantHealthy() external view nonReentrantView returns (bool) {
        // The strict equality is intentional — this view answers "is the
        // backing exactly 1:1 right now?". Off-chain monitors that need
        // direction should call `isUnderCollateralized()` (see ATS-12 fix
        // below). Slither flags strict equality as `incorrect-equality`;
        // the suppression below is the audit-acknowledged baseline.
        // slither-disable-next-line incorrect-equality
        return token.totalSupply() == foreignAsset.balanceOf(address(this));
    }

    /**
     * @notice Returns the signed delta `int256(totalSupply) - int256(balanceOf(wrapper))`.
     * @dev    Sister view to `isInvariantHealthy()` that surfaces the *direction*
     *         of any imbalance — addresses ATS-12. Off-chain monitors should
     *         treat positive values as the urgent alarm (under-backed,
     *         user funds at risk); zero is healthy; negative is over-
     *         collateralized (a third party direct-transferred AJUN to the
     *         wrapper, which is harmless but still surfaced for completeness).
     *         Carries `nonReentrantView` for the same read-only-reentrancy
     *         concern as `isInvariantHealthy()` (audit ATS-11).
     */
    function getInvariantDelta() external view nonReentrantView returns (int256) {
        return int256(token.totalSupply()) - int256(foreignAsset.balanceOf(address(this)));
    }

    /**
     * @notice Returns true iff `totalSupply > balanceOf(wrapper)` — the only
     *         state that puts user funds at risk.
     * @dev    Sister view to `isInvariantHealthy()` (audit ATS-12). This is
     *         the predicate off-chain monitors should alarm on for
     *         operational fidelity.
     */
    function isUnderCollateralized() external view nonReentrantView returns (bool) {
        return token.totalSupply() > foreignAsset.balanceOf(address(this));
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
        require(to != address(this), "AjunaWrapper: rescue to self"); // audit ATS-14
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
     *      Storage layout (verified via solc storageLayout output):
     *        slot 0:        `token` (address, 20B)
     *        slot 1 [0..19]: `foreignAsset` (address, 20B)
     *        slot 1 [20]:    `allowlistEnabled` (bool, 1B) — packed into slot 1
     *        slot 2:        `allowlisted` (mapping head)
     *        slots 3..49:   `__gap[47]` (47 reserved slots)
     *      Original budget: 48 (2 derived state slots + 46 gap). Compiler
     *      packing of `allowlistEnabled` into slot 1 saved one slot, so
     *      `__gap[47]` matches the original 48-slot reservation. Audit ATS-05.
     */
    uint256[47] private __gap;
}
