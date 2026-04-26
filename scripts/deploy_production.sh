#!/bin/bash
set -e

echo "=== Deploying to Polkadot AssetHub Production ==="
echo ""

# ── Check PRIVATE_KEY ──────────────────────────────────────────────
if ! npx hardhat vars get PRIVATE_KEY &> /dev/null; then
    echo "Error: PRIVATE_KEY is not set in Hardhat variables."
    echo "Please set your private key by running:"
    echo "  npx hardhat vars set PRIVATE_KEY"
    echo ""
    echo "WARNING: This is a PRODUCTION deployment. Use a well-secured key."
    exit 1
fi

# ── Check FOREIGN_ASSET ───────────────────────────────────────────
if [ -z "$FOREIGN_ASSET" ]; then
    echo "Error: FOREIGN_ASSET environment variable is not set."
    echo ""
    echo "You need the AJUN Foreign Asset precompile address."
    echo "Run the lookup script to discover it:"
    echo ""
    echo "  npx ts-node scripts/lookup_ajun_asset.ts"
    echo ""
    echo "Then re-run this script with the address:"
    echo "  FOREIGN_ASSET=0x... ./scripts/deploy_production.sh"
    exit 1
fi

echo "Foreign Asset Address: $FOREIGN_ASSET"
echo ""

# ── Confirmation prompt ───────────────────────────────────────────
echo "⚠️  WARNING: This will deploy contracts to Polkadot AssetHub PRODUCTION."
echo "    This is IRREVERSIBLE. Make sure you have:"
echo ""
echo "    ✓ Tested on Chopsticks fork (Level 3)"
echo "    ✓ Tested on testnet (Level 4)"
echo "    ✓ Verified the precompile address is correct"
echo "    ✓ Sufficient DOT in the deployer account for gas"
echo ""
read -p "Continue with production deployment? (yes/no): " confirm

if [ "$confirm" != "yes" ]; then
    echo "Deployment cancelled."
    exit 0
fi

echo ""
echo "Deploying contracts..."
FOREIGN_ASSET="$FOREIGN_ASSET" npx hardhat run scripts/deploy_wrapper.ts --network polkadotMainnet

echo ""
echo "=== Deployment Complete ==="
echo ""
echo "⚠️  POST-DEPLOYMENT CHECKLIST (execute immediately):"
echo ""
echo "  1. FUND THE WRAPPER — Send 0.1 DOT to the Wrapper proxy address as"
echo "     Existential Deposit (via substrate extrinsic, NOT Solidity transfer):"
echo "       balances.transferKeepAlive(dest: <wrapper_proxy>, value: 1_000_000_000)"
echo ""
echo "  2. SEED THE WRAPPER — Deposit a small AJUN amount to keep the asset account alive:"
echo "       foreignAsset.approve(wrapper, 100)"
echo "       wrapper.deposit(100)"
echo ""
echo "  3. VERIFY — Execute a small wrap/unwrap round-trip:"
echo "       WRAPPER_ADDRESS=0x... ERC20_ADDRESS=0x... FOREIGN_ASSET=$FOREIGN_ASSET \\"
echo "         npx hardhat run scripts/e2e_test.ts --network polkadotMainnet"
echo ""
echo "  4. TRANSFER ROLES — Move admin roles to multisig (TWO-STEP + DELAYED)."
echo "     Per docs/PRODUCTION-CHECKLIST.md Phase 8 / 9:"
echo ""
echo "     a) Single-step grants (immediate):"
echo "          AjunaERC20: grantRole(UPGRADER_ROLE, multisig)"
echo ""
echo "     b) Begin two-step admin transfer on the ERC20 (5-day delay):"
echo "          AjunaERC20: beginDefaultAdminTransfer(multisig)"
echo ""
echo "     c) Begin two-step ownership transfer on the wrapper:"
echo "          AjunaWrapper: transferOwnership(multisig)"
echo ""
echo "     d) After the configured delay (production: 5 days), the multisig:"
echo "          AjunaERC20.connect(multisig): acceptDefaultAdminTransfer()"
echo "          AjunaWrapper.connect(multisig): acceptOwnership()"
echo ""
echo "     ! Single-step grantRole(DEFAULT_ADMIN_ROLE, ...) and direct"
echo "       renounceRole(DEFAULT_ADMIN_ROLE, ...) BOTH REVERT — the rules"
echo "       contract enforces the two-step + delayed flow above."
echo ""
echo "  5. RENOUNCE DEPLOYER ROLES (only after step 4d completes):"
echo "       AjunaERC20: renounceRole(UPGRADER_ROLE, deployer)"
echo "       AjunaERC20: (DEFAULT_ADMIN_ROLE was atomically moved in 4d)"
echo "       AjunaWrapper: (ownership atomically moved in 4d)"
echo ""
echo "  6. UPDATE FRONTEND — Set contract addresses in frontend/app.html CONFIG"
echo "       or use URL parameters: ?wrapper=0x...&erc20=0x...&foreign=$FOREIGN_ASSET"
echo ""
echo "  7. RECORD ADDRESSES — Document proxy + implementation addresses for reference"
