// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/**
 * @title AjunaERC20
 * @notice Wrapped representation of the AJUN Foreign Asset as an ERC20 token on Polkadot AssetHub.
 * @dev UUPS-upgradeable. Uses OpenZeppelin AccessControl for role-gated minting and burning.
 *      Only accounts with MINTER_ROLE (intended: the AjunaWrapper treasury) can mint or burn.
 *      Burning requires prior ERC20 approval from the token holder (standard burnFrom pattern).
 *      Upgrades are restricted to accounts with UPGRADER_ROLE.
 */
contract AjunaERC20 is Initializable, ERC20Upgradeable, AccessControlUpgradeable, UUPSUpgradeable {
    /// @notice Role identifier for accounts permitted to mint and burn tokens.
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    /// @notice Role identifier for accounts permitted to authorize contract upgrades.
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    /// @dev Token decimals, set once during initialization to match the native AJUN asset.
    uint8 private _tokenDecimals;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initializes the wrapped AJUN ERC20 token (called once via proxy).
     * @param name_     Token name (e.g. "Wrapped Ajuna").
     * @param symbol_   Token symbol (e.g. "WAJUN").
     * @param admin     Address that receives DEFAULT_ADMIN_ROLE and UPGRADER_ROLE.
     * @param decimals_ Number of decimals — must match the native AJUN asset (typically 12).
     */
    function initialize(
        string memory name_,
        string memory symbol_,
        address admin,
        uint8 decimals_
    ) public initializer {
        require(admin != address(0), "AjunaERC20: admin is zero address");
        require(decimals_ <= 18, "AjunaERC20: decimals exceed 18");
        __ERC20_init(name_, symbol_);
        __AccessControl_init();
        __UUPSUpgradeable_init();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(UPGRADER_ROLE, admin);
        _tokenDecimals = decimals_;
    }

    /// @notice Returns the number of decimals used for display purposes.
    function decimals() public view override returns (uint8) {
        return _tokenDecimals;
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
     */
    uint256[49] private __gap;
}
