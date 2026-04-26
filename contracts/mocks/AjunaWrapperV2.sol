// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../AjunaWrapper.sol";

/**
 * @title AjunaWrapperV2
 * @dev Test-only V2 implementation that adds a new state variable (uses gap slot)
 *      and a migration function to be called during upgradeToAndCall().
 */
contract AjunaWrapperV2 is AjunaWrapper {
    /// @notice New state variable in V2.
    /// @dev Note: `version` does NOT consume a slot from `__gap[46]` — the
    ///      compiler appends it at slot 49, after the gap ends at slot 48.
    ///      Storage-layout fix per audit ATS-06.
    uint256 public version;

    /// @notice Migration function called via upgradeToAndCall().
    /// @dev `onlyOwner` so the migration cannot be front-run by any caller
    ///      between `upgradeToAndCall(impl, "0x")` and the planned migration.
    ///      Production-template parity with `docs/UPGRADE.md` recipes.
    ///      (Audit ATS-03.)
    function migrateToV2() external reinitializer(2) onlyOwner {
        version = 2;
    }

    /// @notice Returns a marker confirming V2 is active.
    function isV2() external pure returns (bool) {
        return true;
    }
}
