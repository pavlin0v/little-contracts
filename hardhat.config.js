require("dotenv").config();
require("@nomicfoundation/hardhat-toolbox");

function accountsFromEnv() {
  const privateKey = process.env.PRIVATE_KEY || "";
  return /^0x[0-9a-fA-F]{64}$/.test(privateKey) ? [privateKey] : [];
}

module.exports = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "paris"
    }
  },
  networks: {
    hardhat: { chainId: 1337 },
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 1337
    },
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || "",
      accounts: accountsFromEnv()
    },
    polygonAmoy: {
      url: process.env.AMOY_RPC_URL || "https://rpc-amoy.polygon.technology/",
      accounts: accountsFromEnv(),
      gasPrice: 30_000_000_000 // 30 gwei — минимум, который принимает Amoy
    }
  },
  etherscan: {
    // Etherscan V2: единый ключ для всех поддерживаемых эксплореров
    // (Etherscan, Polygonscan, BSCscan и др.) — берётся с etherscan.io/myaccount
    apiKey: process.env.ETHERSCAN_API_KEY || ""
  }
};
