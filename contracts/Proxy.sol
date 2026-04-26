// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// Import ERC1967Proxy so Hardhat compiles it and makes the artifact available
// for deployment scripts and tests.  No additional code needed.
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

// Import OZ TimelockController so it compiles and the artifact is available
// to scripts/deploy_timelock.ts and the timelock test group. The contract is
// inventory-only — no production deploy until the team is ready to flip the
// allowlist gate (see docs/PRODUCTION-CHECKLIST.md Phase 10B).
import "@openzeppelin/contracts/governance/TimelockController.sol";
