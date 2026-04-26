// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface IInvariantHealth {
    function isInvariantHealthy() external view returns (bool);
}

/**
 * @title InvariantSnoopToken
 * @notice Test-only ERC20 that, during its `transferFrom` hook, queries
 *         `isInvariantHealthy()` on a configured wrapper and stores the
 *         result. Used as a PoC for ATS-11 (read-only reentrancy) — proves
 *         that an external view consumer reading the invariant during the
 *         deposit's external-call window observes `false` (over-collateralized
 *         transient state) even though the surrounding tx will succeed and
 *         leave the invariant healthy.
 *
 * @dev    The same observation applies to any view consumer reading
 *         `isInvariantHealthy()` while a deposit is mid-flight, regardless
 *         of who the consumer is — this mock just gives the audit a captured
 *         snapshot to assert against.
 */
contract InvariantSnoopToken is ERC20 {
    address public wrapper;
    bool public lastObservation;
    bool public observed;

    constructor() ERC20("Snoop", "SNOOP") {}

    /// @dev 12 to match the test wAJUN's decimals so AjunaWrapper.initialize
    ///      passes its coherence check (audit ATS-08 enforcement).
    function decimals() public pure override returns (uint8) {
        return 12;
    }

    function setWrapper(address w) external {
        wrapper = w;
    }

    function mintTo(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        bool ok = super.transferFrom(from, to, amount);
        if (wrapper != address(0)) {
            // Snapshot what an external integrator reading the view function
            // mid-deposit would see. The wrapper has already received `amount`
            // foreign tokens, but the matching `mint(...)` has not yet run.
            try IInvariantHealth(wrapper).isInvariantHealthy() returns (bool h) {
                lastObservation = h;
                observed = true;
            } catch {
                lastObservation = false;
                observed = true;
            }
        }
        return ok;
    }
}
