/**
 * Lookup AJUN Foreign Asset status on a live AssetHub endpoint.
 *
 * This script queries the chain state to determine:
 *   1. Whether AJUN is registered as a foreign asset
 *   2. Its assigned precompile index (via AssetsPrecompiles pallet)
 *   3. The computed ERC20 precompile address (prefix 0x0220)
 *   4. Its metadata (name, symbol, decimals)
 *
 * The ForeignAssetIdExtractor (polkadot-sdk PR #10869) assigns each foreign asset
 * a sequential u32 index, stored in the AssetsPrecompiles pallet:
 *   - ForeignAssetIdToAssetIndex: Location → u32
 *   - AssetIndexToForeignAssetId: u32 → Location
 *   - NextAssetIndex: u32 (counter)
 *
 * This information is essential for configuring production deployments.
 *
 * Usage:
 *   npx ts-node scripts/lookup_ajun_asset.ts [rpc_url]
 *
 * Examples:
 *   npx ts-node scripts/lookup_ajun_asset.ts                                          # Mainnet (default)
 *   npx ts-node scripts/lookup_ajun_asset.ts wss://westend-asset-hub-rpc.polkadot.io  # Westend testnet
 *
 * Default RPC: wss://polkadot-asset-hub-rpc.polkadot.io
 *
 * NOTE: This script requires @polkadot/api.  Install if needed:
 *   npm install --save-dev @polkadot/api
 */

// ── Precompile address computation (standalone, no deps) ──────────
function computePrecompileAddress(assetIndex: number, prefix: number = 0x0220): string {
  const buf = Buffer.alloc(20, 0);
  buf.writeUInt32BE(assetIndex, 0);
  buf.writeUInt16BE(prefix, 16);
  return "0x" + buf.toString("hex");
}

function extractStorageNumber(value: any): number | null {
  if (!value || value.isEmpty) {
    return null;
  }

  if (value.isSome && typeof value.unwrap === "function") {
    return extractStorageNumber(value.unwrap());
  }

  if (typeof value.toNumber === "function") {
    return value.toNumber();
  }

  const jsonValue = typeof value.toJSON === "function" ? value.toJSON() : value;
  if (typeof jsonValue === "number") {
    return jsonValue;
  }

  if (typeof jsonValue === "string" && jsonValue !== "") {
    return Number(jsonValue);
  }

  return null;
}

// ── AJUN MultiLocation (Parachain 2051) ───────────────────────────
const AJUN_MULTI_LOCATION = {
  parents: 1,
  interior: { X1: [{ Parachain: 2051 }] },
};

async function main() {
  // Try to load @polkadot/api — if not installed, print instructions.
  let ApiPromise: any, WsProvider: any;
  try {
    const api = await import("@polkadot/api");
    ApiPromise = api.ApiPromise;
    WsProvider = api.WsProvider;
  } catch {
    console.log("═══════════════════════════════════════════════════════════");
    console.log("  @polkadot/api is not installed.");
    console.log("  Install it to query live chain state:");
    console.log("    npm install --save-dev @polkadot/api");
    console.log("");
    console.log("  In the meantime, here are precompile addresses for");
    console.log("  common foreign asset indices (prefix 0x0220):");
    console.log("═══════════════════════════════════════════════════════════");
    for (const id of [0, 1, 2, 3, 5, 10]) {
      console.log(`  Index ${String(id).padStart(3)} → ${computePrecompileAddress(id)}`);
    }
    console.log("");
    console.log("  AJUN (Parachain 2051) MultiLocation:");
    console.log(`  ${JSON.stringify(AJUN_MULTI_LOCATION)}`);
    console.log("");
    console.log("  The exact index depends on creation order of foreign assets.");
    console.log("  Install @polkadot/api and re-run to query the live chain.");
    return;
  }

  const rpcUrl = process.argv[2] || "wss://polkadot-asset-hub-rpc.polkadot.io";
  console.log(`Connecting to ${rpcUrl}...`);

  const provider = new WsProvider(rpcUrl);
  const api = await ApiPromise.create({ provider });

  const chain = (await api.rpc.system.chain()).toString();
  const specVersion = api.runtimeVersion.specVersion.toString();
  console.log(`Connected to chain: ${chain}`);
  console.log(`Runtime version: ${specVersion}\n`);

  console.log("Looking up AJUN foreign asset...");
  console.log(`MultiLocation: ${JSON.stringify(AJUN_MULTI_LOCATION)}\n`);

  // ── Step 1: Check if AJUN is registered as a Foreign Asset ──────
  let ajunRegistered = false;
  try {
    if (api.query.foreignAssets) {
      const asset = await api.query.foreignAssets.asset(AJUN_MULTI_LOCATION);

      if (asset && !asset.isEmpty) {
        ajunRegistered = true;
        const data = asset.toJSON();
        console.log("✅ AJUN is registered as a Foreign Asset!");
        console.log("  Asset data:", JSON.stringify(data, null, 2));

        // Try to get metadata
        try {
          const metadata = await api.query.foreignAssets.metadata(AJUN_MULTI_LOCATION);
          if (metadata && !metadata.isEmpty) {
            const meta = metadata.toJSON();
            console.log("  Metadata:", JSON.stringify(meta, null, 2));
          }
        } catch {
          console.log("  (No metadata found)");
        }
      } else {
        console.log("❌ AJUN is NOT registered as a Foreign Asset on this chain.");
        console.log("   It needs to be transferred via XCM from Ajuna Network first.");
      }
    } else {
      console.log("⚠️  foreignAssets pallet not found in this runtime.");
    }
  } catch (e: any) {
    console.log(`Error querying foreignAssets pallet: ${e.message}`);
  }

  // ── Step 2: Query the AssetsPrecompiles pallet for the index ────
  let precompileIndex: number | null = null;
  let precompileAddress: string | null = null;

  try {
    if (api.query.assetsPrecompiles) {
      console.log("\n═══ AssetsPrecompiles Pallet (ForeignAssetIdExtractor) ═══");

      // Query NextAssetIndex — how many foreign assets have been indexed
      try {
        const nextIndex = await api.query.assetsPrecompiles.nextAssetIndex();
        console.log(`  Total indexed foreign assets: ${nextIndex.toString()}`);
      } catch {
        console.log("  (Could not read nextAssetIndex)");
      }

      // Forward lookup: Location → u32 index
      try {
        const indexResult = await api.query.assetsPrecompiles.foreignAssetIdToAssetIndex(
          AJUN_MULTI_LOCATION
        );

        precompileIndex = extractStorageNumber(indexResult);

        if (precompileIndex !== null) {
          precompileAddress = computePrecompileAddress(precompileIndex as number);

          console.log(`\n  ✅ AJUN precompile index: ${precompileIndex}`);
          console.log(`  ✅ AJUN precompile address: ${precompileAddress}`);

          // Verify reverse mapping
          try {
            const reverseResult = await api.query.assetsPrecompiles.assetIndexToForeignAssetId(
              precompileIndex
            );
            if (reverseResult && !reverseResult.isEmpty) {
              console.log(`  ✅ Reverse mapping verified: index ${precompileIndex} → ${JSON.stringify(reverseResult.toJSON())}`);
            }
          } catch {
            console.log("  ⚠️  Could not verify reverse mapping");
          }
        } else {
          console.log("\n  ❌ AJUN has NO precompile index assigned.");
          if (ajunRegistered) {
            console.log("     The asset is registered but the index mapping may not have");
            console.log("     been created yet. This can happen if:");
            console.log("     - The runtime upgrade with ForeignAssetIdExtractor hasn't been enacted");
            console.log("     - The migration to backfill existing foreign assets hasn't run yet");
          }
        }
      } catch (e: any) {
        console.log(`  Error querying foreignAssetIdToAssetIndex: ${e.message}`);
      }
    } else {
      console.log("\n⚠️  assetsPrecompiles pallet not found in this runtime.");
      console.log("   The ForeignAssetIdExtractor (PR #10869) runtime upgrade may not be");
      console.log("   enacted yet on this chain. Check the runtime version.");
    }
  } catch (e: any) {
    console.log(`Error querying assetsPrecompiles: ${e.message}`);
  }

  // ── Step 3: Also check native assets pallet ─────────────────────
  try {
    if (api.query.assets) {
      console.log("\n═══ Native Assets Scan ═══");
      for (const id of [2051, 1984, 0, 1]) {
        const asset = await api.query.assets.asset(id);
        if (asset && !asset.isEmpty) {
          const meta = await api.query.assets.metadata(id);
          const name = meta?.name?.toHuman() || "?";
          const symbol = meta?.symbol?.toHuman() || "?";
          const nativePrecompile = computePrecompileAddress(id, 0x0120);
          console.log(`  Asset ID ${id}: ${name} (${symbol}) → ${nativePrecompile}`);
        }
      }
    }
  } catch {
    console.log("  (Could not query native assets)");
  }

  // ── Step 4: Print summary and deployment instructions ───────────
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  SUMMARY");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Chain:              ${chain}`);
  console.log(`  Runtime version:    ${specVersion}`);
  console.log(`  AJUN registered:    ${ajunRegistered ? "Yes" : "No"}`);
  console.log(`  Precompile index:   ${precompileIndex !== null ? precompileIndex : "Not assigned"}`);
  console.log(`  Precompile address: ${precompileAddress ? precompileAddress : "N/A"}`);

  if (precompileAddress) {
    console.log("\n  ── Ready for deployment! ──────────────────────────────");
    console.log(`\n  Use this address for deployment:`);
    console.log(`    FOREIGN_ASSET=${precompileAddress}`);
    console.log(`\n  Deploy to production:`);
    console.log(`    FOREIGN_ASSET=${precompileAddress} npx hardhat run scripts/deploy_wrapper.ts --network polkadotMainnet`);
    console.log(`\n  Deploy to testnet:`);
    console.log(`    FOREIGN_ASSET=${precompileAddress} npx hardhat run scripts/deploy_wrapper.ts --network polkadotTestnet`);
    console.log(`\n  Test on Chopsticks fork:`);
    console.log(`    FOREIGN_ASSET=${precompileAddress} npx hardhat run scripts/deploy_wrapper.ts --network local`);
  } else if (ajunRegistered) {
    console.log("\n  ⚠️  AJUN is registered but has no precompile index.");
    console.log("  The ForeignAssetIdExtractor runtime upgrade may not be enacted yet.");
    console.log("  Check: https://polkadot.js.org/apps/?rpc=" + rpcUrl + "#/chainstate");
  } else {
    console.log("\n  ❌  AJUN must be registered as a foreign asset first.");
    console.log("  Transfer AJUN via XCM from Ajuna Network (Parachain 2051) to AssetHub.");
  }

  // ── Reference table ─────────────────────────────────────────────
  console.log("\n═══ Precompile Address Reference ═══");
  console.log("  Formula: [index(4B BE)] [zeros(12B)] [prefix(2B BE)] [0x0000]");
  console.log("");
  console.log("  Native assets prefix:  0x0120 (pallet-assets TrustBacked)");
  console.log("  Foreign assets prefix: 0x0220 (ForeignAssetIdExtractor)");
  console.log("  Pool assets prefix:    0x0320 (pallet-assets PoolAssets)");
  console.log("");
  console.log("  Example foreign asset precompile addresses:");
  for (const id of [0, 1, 2, 3]) {
    console.log(`    Index ${id} → ${computePrecompileAddress(id)}`);
  }
  console.log("");

  await api.disconnect();
}

main().catch(console.error);
