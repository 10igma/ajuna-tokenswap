// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../AjunaWrapper.sol";

/**
 * @title AjunaWrapperV2
 * @dev Test-only V2 implementation that adds a new state variable (uses gap slot)
 *      and a migration function to be called during upgradeToAndCall().
 */
contract AjunaWrapperV2 is AjunaWrapper {
    /// @notice New state variable in V2 — occupies one slot from __gap.
    uint256 public version;

    /// @notice Migration function called via upgradeToAndCall().
    function migrateToV2() external reinitializer(2) {
        version = 2;
    }

    /// @notice Returns a marker confirming V2 is active.
    function isV2() external pure returns (bool) {
        return true;
    }
}
