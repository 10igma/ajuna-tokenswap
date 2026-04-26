// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title HalfBadERC20
 * @notice Test-only ERC20 that **succeeds on `transferFrom`** but **returns
 *         `false` from `transfer`**. Lets a wrapper `deposit()` succeed
 *         (user → wrapper transferFrom is normal) and forces the subsequent
 *         `withdraw()` to revert through SafeERC20's safeTransfer (audit
 *         LOW-A withdraw-side defense, paired with `BadERC20` for the
 *         deposit-side defense).
 *
 * @dev    `transfer` returns `false` without reverting — the bool path that
 *         silently fails on naive code. SafeERC20 catches it and reverts.
 */
contract HalfBadERC20 is ERC20 {
    constructor() ERC20("HalfBad", "HBAD") {}

    /// @dev 12 to match the test wAJUN's decimals so AjunaWrapper.initialize
    ///      passes its coherence check (audit ATS-08 enforcement).
    function decimals() public pure override returns (uint8) {
        return 12;
    }

    function mintTo(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @dev Always returns false silently (the safeTransfer-killer behavior).
    function transfer(address, uint256) public pure override returns (bool) {
        return false;
    }

    // transferFrom inherits standard ERC20 behaviour — succeeds normally.
}
