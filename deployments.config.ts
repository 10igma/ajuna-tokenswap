/**
 * Deployment & environment configuration for multi-network testing.
 *
 * Each environment captures:
 *   - Network metadata (chainId, RPC)
 *   - The Foreign Asset precompile address (production: derived from the on-chain asset ID)
 *   - Deployed contract addresses (filled in after deployment)
 *   - Token configuration (decimals, symbol)
 *
 * Usage:
 *   import { getEnvConfig } from "./deployments.config";
 *   const cfg = getEnvConfig("local");
 */

export interface EnvConfig {
  /** Human-readable label */
  name: string;
  /** EVM chain-ID exposed by eth-rpc adapter */
  chainId: number;
  /** JSON-RPC endpoint */
  rpcUrl: string;
  /** AJUN decimals (native: 12) */
  decimals: number;
  /** Symbol for the wrapped token */
  symbol: string;

  /**
   * Foreign Asset precompile address.
   *
   * On AssetHub production/testnet this is a deterministic address derived from the
   * local asset ID assigned to the AJUN foreign asset.
   *
   * Formula (20 bytes):
   *   [asset_id (4B big-endian)] [zeros (12B)] [PREFIX (2B big-endian)] [0x0000]
   *
   * The PREFIX depends on the pallet instance:
   *   - Native assets (pallet-assets):   0x0120
   *   - Foreign assets:                  0x0220  (ForeignAssetIdExtractor, polkadot-sdk PR #10869)
   *
   * Example: asset ID 1984 (USDT) with prefix 0x0120
   *   → 0x000007C000000000000000000000000001200000
   *
   * On the local dev node the revive-dev-node runtime has NO pallet-assets,
   * so we deploy an ordinary ERC20 contract as a stand-in.
   */
  foreignAssetAddress: string;

  /** Deployed AjunaWrapper (treasury) address.  Set after deployment. */
  wrapperAddress: string;
  /** Deployed AjunaERC20 (wAJUN) address.  Set after deployment. */
  erc20Address: string;
}

// ─── Environment definitions ──────────────────────────────────────────────────

const configs: Record<string, EnvConfig> = {
  /**
   * LOCAL DEV NODE
   *
   * Uses revive-dev-node + eth-rpc.
   * pallet-assets is NOT part of this runtime, so the "foreign asset" must be
   * a regular ERC20 contract deployed separately (mock).
   *
   * Workflow:
   *   1. Start node:        ./scripts/run_local_node.sh
   *   2. Fund account:      npx hardhat run scripts/fund_account.ts --network local
   *   3. Deploy mock FA:    npx hardhat run scripts/deploy_mock_foreign_asset.ts --network local
   *   4. Deploy contracts:  FOREIGN_ASSET=0x<mock> npx hardhat run scripts/deploy_wrapper.ts --network local
   *   5. Run E2E:           npx hardhat run scripts/e2e_test.ts --network local
   */
  local: {
    name: "Local Dev Node",
    chainId: 420420420,
    rpcUrl: "http://127.0.0.1:8545",
    decimals: 12,
    symbol: "wAJUN",
    foreignAssetAddress: "", // Filled after deploying mock
    wrapperAddress: "",      // Filled after deployment
    erc20Address: "",        // Filled after deployment
  },

  /**
   * POLKADOT HUB TESTNET
   *
   * The testnet runtime includes pallet-assets and pallet-foreign-assets.
   * AJUN must first be transferred via XCM from Ajuna's testnet to AssetHub testnet,
   * which registers it as a foreign asset.
   *
   * The ForeignAssetIdExtractor (polkadot-sdk PR #10869) assigns a sequential u32
   * index to each foreign asset, stored in the AssetsPrecompiles pallet.
   * Query the index and compute the precompile address:
   *   npx ts-node scripts/lookup_ajun_asset.ts wss://westend-asset-hub-rpc.polkadot.io
   */
  testnet: {
    name: "Polkadot Hub TestNet",
    chainId: 420420417,
    rpcUrl: "https://services.polkadothub-rpc.com/testnet",
    decimals: 12,
    symbol: "wAJUN",
    foreignAssetAddress: "", // Run lookup_ajun_asset.ts to discover; computePrecompileAddress(index, 0x0220)
    wrapperAddress: "",      // Filled after deployment
    erc20Address: "",        // Filled after deployment
  },

  /**
   * CHOPSTICKS (forked AssetHub mainnet)
   *
   * Forks real AssetHub state including all registered foreign assets.
   * Requires: npx @acala-network/chopsticks --config=chopsticks.yml
   *
   * The AJUN foreign asset (if registered on mainnet) will be available at its
   * real precompile address.  Fund a test account using Chopsticks' `dev_setStorage`.
   */
  chopsticks: {
    name: "Chopsticks (AssetHub Fork)",
    chainId: 420420420, // Chopsticks inherits the forked chain ID
    rpcUrl: "http://127.0.0.1:8545",
    decimals: 12,
    symbol: "wAJUN",
    foreignAssetAddress: "", // Real precompile address from mainnet state
    wrapperAddress: "",      // Filled after deployment on fork
    erc20Address: "",        // Filled after deployment on fork
  },

  /**
   * POLKADOT ASSETHUB MAINNET (Production)
   *
   * Production deployment on Polkadot AssetHub.
   * The ForeignAssetIdExtractor (polkadot-sdk PR #10869) is live — foreign assets
   * are accessible via ERC20 precompiles at prefix 0x0220.
   *
   * To discover the AJUN precompile address:
   *   npx ts-node scripts/lookup_ajun_asset.ts
   *
   * The script queries the AssetsPrecompiles pallet:
   *   - assetsPrecompiles.foreignAssetIdToAssetIndex(Location) → u32 index
   *   - Precompile address = computePrecompileAddress(index, 0x0220)
   *
   * Deploy:
   *   FOREIGN_ASSET=0x<address> npx hardhat run scripts/deploy_wrapper.ts --network polkadotMainnet
   *   Or: ./scripts/deploy_production.sh
   */
  production: {
    name: "Polkadot AssetHub (Production)",
    chainId: 420420420,
    rpcUrl: "https://polkadot-asset-hub-eth-rpc.polkadot.io",
    decimals: 12,
    symbol: "wAJUN",
    foreignAssetAddress: "", // Run: npx ts-node scripts/lookup_ajun_asset.ts
    wrapperAddress: "",      // Filled after deployment
    erc20Address: "",        // Filled after deployment
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Compute the deterministic ERC20 precompile address for a given asset ID.
 *
 * Layout (20 bytes):
 *   bytes  0..4   = asset ID (uint32 big-endian)
 *   bytes  4..16  = 0x000000000000000000000000
 *   bytes 16..18  = PREFIX (uint16 big-endian)
 *   bytes 18..20  = 0x0000
 *
 * @param assetId  The local integer asset ID assigned by pallet-assets
 * @param prefix   The precompile prefix (0x0120 for native assets, 0x0220 for foreign assets)
 */
export function computePrecompileAddress(
  assetId: number,
  prefix: number = 0x0120
): string {
  const buf = Buffer.alloc(20, 0);
  buf.writeUInt32BE(assetId, 0);
  buf.writeUInt16BE(prefix, 16);
  return "0x" + buf.toString("hex");
}

/**
 * Get the configuration for a named environment.
 */
export function getEnvConfig(env: string): EnvConfig {
  const cfg = configs[env];
  if (!cfg) {
    throw new Error(
      `Unknown environment "${env}". Available: ${Object.keys(configs).join(", ")}`
    );
  }
  return { ...cfg }; // Return a copy
}

/**
 * Print precompile address for a given asset ID (handy for CLI usage).
 *
 *   npx ts-node -e "import {computePrecompileAddress} from './deployments.config'; console.log(computePrecompileAddress(1984))"
 */
export function printPrecompileAddress(assetId: number, prefix?: number): void {
  const addr = computePrecompileAddress(assetId, prefix);
  console.log(`Asset ID: ${assetId}`);
  console.log(`Prefix:   0x${(prefix ?? 0x0120).toString(16).padStart(4, "0")}`);
  console.log(`Address:  ${addr}`);
}
