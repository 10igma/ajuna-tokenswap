import { HardhatUserConfig, vars } from "hardhat/config";
import "@parity/hardhat-polkadot";
import "@nomicfoundation/hardhat-ignition-ethers";
import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-chai-matchers";
import "@typechain/hardhat";

// Retrieve the private key from Hardhat configuration variables
// Run 'npx hardhat vars set PRIVATE_KEY' to set it.
// Default fallback for CI/Local prevents crash if not set, but won't work for real deploy.
const PRIVATE_KEY = vars.has("PRIVATE_KEY") ? vars.get("PRIVATE_KEY") : "0x0000000000000000000000000000000000000000000000000000000000000000";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    local: {
        url: "http://127.0.0.1:8545",
        chainId: 420420420,
        // Alith — pre-funded dev account on revive-dev-node
        // H160: 0xf24FF3a9CF04c71Dbc94D0b566f7A27B94566cac
        accounts: ["0x5fb92d6e98884f76de468fa3f6278f8807c48bebc13595d45af5bdc4da702133"],
        gasPrice: 50000000000, // 50 gwei (matches base fee)
        gas: 6000000,
        timeout: 60000,
    },
    polkadotTestnet: {
        url: 'https://services.polkadothub-rpc.com/testnet',
        chainId: 420420417, // Polkadot Hub TestNet per official docs
        accounts: [PRIVATE_KEY],
    }
  },
};

export default config;
