// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlDefaultAdminRulesUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/**
 * @title AjunaERC20
 * @notice Wrapped representation of the AJUN Foreign Asset as an ERC20 token on Polkadot AssetHub.
 * @dev UUPS-upgradeable. Uses `AccessControlDefaultAdminRulesUpgradeable` so the
 *      `DEFAULT_ADMIN_ROLE` follows a two-step transfer with a configurable
 *      delay — the same typo-resistance the wrapper gets from
 *      `Ownable2StepUpgradeable`. There is exactly one `DEFAULT_ADMIN_ROLE`
 *      holder at any time; transfer requires `beginDefaultAdminTransfer`
 *      from the current admin and `acceptDefaultAdminTransfer` from the
 *      proposed admin after the configured delay.
 *
 *      Only accounts with `MINTER_ROLE` (intended: the `AjunaWrapper` treasury)
 *      can mint or burn. Burning requires prior ERC20 approval from the token
 *      holder (standard `burnFrom` pattern). Upgrades are restricted to accounts
 *      with `UPGRADER_ROLE`.
 *
 *      `MINTER_ROLE` is **bound** to a single address (`boundMinter`) via the
 *      one-shot `bindMinter` flow. After binding, `_grantRole(MINTER_ROLE, X)`
 *      reverts unless `X == boundMinter`. This closes the audit's ATS-04
 *      finding: an `DEFAULT_ADMIN_ROLE` holder that diverges from the
 *      wrapper's `owner()` cannot grant `MINTER_ROLE` to a new address and
 *      mint unbacked wAJUN.
 */
contract AjunaERC20 is Initializable, ERC20Upgradeable, AccessControlDefaultAdminRulesUpgradeable, UUPSUpgradeable {
    /// @notice Role identifier for accounts permitted to mint and burn tokens.
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    /// @notice Role identifier for accounts permitted to authorize contract upgrades.
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    /// @dev Token decimals, set once during initialization to match the native AJUN asset.
    ///      Packed in slot 0 with `boundMinter` (1 + 20 = 21 bytes).
    uint8 private _tokenDecimals;

    /// @notice The exclusively bound minter (intended: the `AjunaWrapper` proxy address).
    ///         Once set via `bindMinter`, no other address can ever hold
    ///         `MINTER_ROLE`. The current `_grantRole` override enforces this.
    ///         Packs into slot 0 with `_tokenDecimals`.
    address public boundMinter;

    /// @notice Emitted when `bindMinter` succeeds. Fires exactly once per proxy.
    event MinterBound(address indexed minter);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initializes the wrapped AJUN ERC20 token (called once via proxy).
     * @param name_              Token name (e.g. "Wrapped Ajuna").
     * @param symbol_            Token symbol (e.g. "WAJUN").
     * @param admin              Address that receives `DEFAULT_ADMIN_ROLE` and `UPGRADER_ROLE`.
     * @param decimals_          Number of decimals — must match the native AJUN asset (typically 12).
     * @param initialAdminDelay  Delay (in seconds) between
     *                           `beginDefaultAdminTransfer` and the time
     *                           `acceptDefaultAdminTransfer` can be successfully
     *                           called. Production: ~5 days (432000). Tests: 0.
     */
    function initialize(
        string memory name_,
        string memory symbol_,
        address admin,
        uint8 decimals_,
        uint48 initialAdminDelay
    ) public initializer {
        require(admin != address(0), "AjunaERC20: admin is zero address");
        require(decimals_ <= 18, "AjunaERC20: decimals exceed 18");
        __ERC20_init(name_, symbol_);
        __AccessControlDefaultAdminRules_init(initialAdminDelay, admin);
        _grantRole(UPGRADER_ROLE, admin);
        _tokenDecimals = decimals_;
    }

    /// @notice Returns the number of decimals used for display purposes.
    function decimals() public view override returns (uint8) {
        return _tokenDecimals;
    }

    /**
     * @notice One-shot binding of the exclusive `MINTER_ROLE` holder. Callable
     *         once by `DEFAULT_ADMIN_ROLE`. The bound address is automatically
     *         granted `MINTER_ROLE`; subsequent grants of `MINTER_ROLE` to any
     *         other address revert.
     * @dev    Closes ATS-04 (audit/REPORT.md): even if `DEFAULT_ADMIN_ROLE`
     *         and the wrapper's `owner()` diverge, the ERC20 admin cannot
     *         grant `MINTER_ROLE` to an attacker-controlled address. The bound
     *         minter is the wrapper proxy address (stable across UUPS upgrades).
     * @param minter The wrapper proxy address that becomes the sole minter.
     */
    function bindMinter(address minter) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(boundMinter == address(0), "AjunaERC20: minter already bound");
        require(minter != address(0), "AjunaERC20: zero minter");
        boundMinter = minter;
        _grantRole(MINTER_ROLE, minter);
        emit MinterBound(minter);
    }

    /**
     * @dev Enforces the `boundMinter` invariant on every grant of `MINTER_ROLE`.
     *      All other roles (including `DEFAULT_ADMIN_ROLE` and `UPGRADER_ROLE`)
     *      pass through unchanged. The `boundMinter == 0` early-out lets
     *      `bindMinter` perform the very first grant of `MINTER_ROLE` cleanly.
     */
    function _grantRole(bytes32 role, address account)
        internal
        virtual
        override(AccessControlDefaultAdminRulesUpgradeable)
        returns (bool)
    {
        if (role == MINTER_ROLE && boundMinter != address(0)) {
            require(account == boundMinter, "AjunaERC20: MINTER_ROLE bound to a single address");
        }
        return super._grantRole(role, account);
    }

    /**
     * @notice Creates `amount` new tokens and assigns them to `to`.
     * @dev Restricted to accounts with MINTER_ROLE.
     * @param to     Recipient of the minted tokens.
     * @param amount Number of tokens to mint (in smallest unit).
     */
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }

    /**
     * @notice Burns `amount` tokens from `from`, deducting from the caller's allowance.
     * @dev Restricted to accounts with MINTER_ROLE.
     *      The caller (e.g. AjunaWrapper) must have been approved by `from` via `approve()`.
     *      This follows the standard ERC20 "burnFrom" pattern for safety.
     * @param from   Address whose tokens will be burned.
     * @param amount Number of tokens to burn (in smallest unit).
     */
    function burnFrom(address from, uint256 amount) public onlyRole(MINTER_ROLE) {
        _spendAllowance(from, _msgSender(), amount);
        _burn(from, amount);
    }

    /**
     * @dev Restricts contract upgrades to accounts with UPGRADER_ROLE.
     */
    function _authorizeUpgrade(address newImplementation) internal view override onlyRole(UPGRADER_ROLE) {
        require(newImplementation.code.length > 0, "AjunaERC20: implementation not a contract");
    }

    /**
     * @dev Reserved storage gap for future base contract upgrades.
     *      Slot 0: `_tokenDecimals` (1B) packed with `boundMinter` (20B). 1 slot used.
     *      `__gap[49]` follows.
     */
    uint256[49] private __gap;
}
