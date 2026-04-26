#!/bin/bash
set -e

echo "=== Deploying to Polkadot AssetHub Testnet ==="
echo ""

# ── Check PRIVATE_KEY ──────────────────────────────────────────────
if ! npx hardhat vars get PRIVATE_KEY &> /dev/null; then
    echo "Error: PRIVATE_KEY is not set in Hardhat variables."
    echo "Please set your private key by running:"
    echo "  npx hardhat vars set PRIVATE_KEY"
    echo ""
    echo "WARNING: Ensure this account has testnet funds (PAS)."
    exit 1
fi

# ── Check FOREIGN_ASSET ───────────────────────────────────────────
if [ -z "$FOREIGN_ASSET" ]; then
    echo "Error: FOREIGN_ASSET environment variable is not set."
    echo ""
    echo "You need the AJUN Foreign Asset precompile address on testnet."
    echo "Run the lookup script to discover it:"
    echo ""
    echo "  npx ts-node scripts/lookup_ajun_asset.ts wss://westend-asset-hub-rpc.polkadot.io"
    echo ""
    echo "Then re-run this script with the address:"
    echo "  FOREIGN_ASSET=0x... ./scripts/deploy_testnet.sh"
    exit 1
fi

echo "Foreign Asset Address: $FOREIGN_ASSET"
echo ""
echo "Deploying contracts..."
FOREIGN_ASSET="$FOREIGN_ASSET" npx hardhat run scripts/deploy_wrapper.ts --network polkadotTestnet

echo ""
echo "=== Deployment Complete ==="
echo ""
echo "POST-DEPLOYMENT CHECKLIST:"
echo "  1. Send 0.1 PAS to the Wrapper proxy address as Existential Deposit"
echo "     (substrate: balances.transferKeepAlive)."
echo "  2. Seed the Wrapper with a small AJUN deposit to keep its asset account alive."
echo "  3. Verify a small wrap/unwrap round-trip:"
echo "       WRAPPER_ADDRESS=0x... ERC20_ADDRESS=0x... FOREIGN_ASSET=$FOREIGN_ASSET \\"
echo "         npx hardhat run scripts/e2e_test.ts --network polkadotTestnet"
echo "  4. Transfer admin roles to a multisig and renounce from deployer when done."
