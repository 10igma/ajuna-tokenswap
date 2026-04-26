// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title ReentrantToken
 * @dev Malicious ERC20 mock that attempts reentrancy on AjunaWrapper.deposit()
 *      during transferFrom(). Used only for testing.
 */
contract ReentrantToken is ERC20 {
    address public target;
    bool public attackEnabled;

    constructor() ERC20("Reentrant", "REENT") {}

    /// @dev 12 to match the test wAJUN's decimals so AjunaWrapper.initialize
    ///      passes its coherence check (audit ATS-08 enforcement).
    function decimals() public pure override returns (uint8) {
        return 12;
    }

    function setTarget(address _target) external {
        target = _target;
    }

    function enableAttack() external {
        attackEnabled = true;
    }

    function mintTo(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        bool result = super.transferFrom(from, to, amount);

        // Attempt reentrancy: call deposit again during transferFrom
        if (attackEnabled && target != address(0)) {
            attackEnabled = false; // prevent infinite loop
            (bool success,) = target.call(
                abi.encodeWithSignature("deposit(uint256)", amount)
            );
            // We don't care if it succeeds — we just want to verify the guard blocks it
            // Silence unused variable warning
            success;
        }

        return result;
    }
}
