// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title FeeOnTransferERC20
 * @notice Test-only ERC20 that takes a 10% fee on every `transferFrom`,
 *         simulating tokens like USDT historical, paxg, deflationary memes.
 *         Used to verify that AjunaWrapper.deposit mints exactly what the
 *         treasury actually received (LOW-1 defense-in-depth).
 *
 * @dev    On `transferFrom(from, to, amount)`:
 *           - Spends full `amount` allowance from `from`.
 *           - Burns 10% of `amount` from `from`'s balance (the "fee").
 *           - Transfers the remaining 90% to `to`.
 *         A naive wrapper that mints `amount` would silently under-collateralize
 *         itself. The fixed wrapper (LOW-1) reads `balanceOf(this)` before /
 *         after and mints only the delta.
 */
contract FeeOnTransferERC20 is ERC20 {
    uint256 public constant FEE_BPS = 1000; // 10% in basis points
    uint256 public constant BPS_DENOM = 10_000;

    constructor() ERC20("Fee", "FEE") {}

    /// @dev 12 to match the test wAJUN's decimals so AjunaWrapper.initialize
    ///      passes its coherence check (audit ATS-08 enforcement).
    function decimals() public pure override returns (uint8) {
        return 12;
    }

    function mintTo(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        _spendAllowance(from, _msgSender(), amount);
        uint256 fee = (amount * FEE_BPS) / BPS_DENOM;
        uint256 net = amount - fee;
        _burn(from, fee);
        _transfer(from, to, net);
        return true;
    }
}
