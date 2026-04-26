// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title IERC20Precompile
 * @dev Interface for the ERC20 Precompile on Polkadot AssetHub.
 * See: https://docs.polkadot.com/smart-contracts/precompiles/erc20/
 */
interface IERC20Precompile {
    // Implemented functions
    function totalSupply() external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);

    // Metadata — used by AjunaWrapper.initialize for the decimals coherence check (audit ATS-08).
    function decimals() external view returns (uint8);
}
