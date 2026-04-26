// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../AjunaERC20.sol";

/**
 * @title AjunaERC20V2
 * @dev Test-only V2 implementation that adds a new state variable (uses gap slot)
 *      and a migration function to be called during upgradeToAndCall().
 */
contract AjunaERC20V2 is AjunaERC20 {
    /// @notice New state variable in V2.
    uint256 public version;

    /// @notice Migration function called via upgradeToAndCall().
    /// @dev `onlyRole(UPGRADER_ROLE)` so the migration cannot be front-run
    ///      by any caller between `upgradeToAndCall(impl, "0x")` and the
    ///      planned migration. Audit ATS-03.
    function migrateToV2() external reinitializer(2) onlyRole(UPGRADER_ROLE) {
        version = 2;
    }

    /// @notice Returns a marker confirming V2 is active.
    function isV2() external pure returns (bool) {
        return true;
    }
}
