// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title BadERC20
 * @notice Test-only ERC20 that violates the standard by returning `false`
 *         from `transfer` and `transferFrom` instead of reverting. Used to
 *         verify that AjunaWrapper.deposit / withdraw reject misbehaving
 *         tokens via SafeERC20 (LOW-A defense-in-depth).
 *
 * @dev    Solidity / SafeERC20 expectations:
 *           - Plain `IERC20.transferFrom` returns `bool`. Some real-world
 *             tokens (USDT-style) return nothing; some return `false` on
 *             partial failure. Both modes break the naive `require(ok)`
 *             pattern. SafeERC20 handles both correctly.
 *           - This mock takes the second route: it always returns `false`
 *             without reverting, so a wrapper that just trusts the bool will
 *             silently no-op.
 */
contract BadERC20 is ERC20 {
    constructor() ERC20("Bad", "BAD") {}

    function mintTo(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @dev Always returns false without reverting. Overrides ERC20.transfer.
    function transfer(address, uint256) public pure override returns (bool) {
        return false;
    }

    /// @dev Always returns false without reverting. Overrides ERC20.transferFrom.
    function transferFrom(address, address, uint256) public pure override returns (bool) {
        return false;
    }
}
