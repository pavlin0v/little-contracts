const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const signers = await hre.ethers.getSigners();
  const [deployer, providerWallet, clientWallet] = signers;
  const network = await hre.ethers.provider.getNetwork();
  console.log("Deploying with", deployer.address, "on", hre.network.name, "(chainId", Number(network.chainId) + ")");

  // На тестнете в .env обычно один PRIVATE_KEY, так что provider/client signers недоступны.
  const hasTestWallets = signers.length >= 3;

  const Token = await hre.ethers.getContractFactory("GPURentalToken");
  const token = await Token.deploy(deployer.address);
  await token.waitForDeployment();
  console.log("Token:", token.target);

  const Reputation = await hre.ethers.getContractFactory("ProviderReputation");
  const reputation = await Reputation.deploy(token.target);
  await reputation.waitForDeployment();
  console.log("Reputation:", reputation.target);

  const Marketplace = await hre.ethers.getContractFactory("Marketplace");
  const marketplace = await Marketplace.deploy(token.target, deployer.address, reputation.target);
  await marketplace.waitForDeployment();
  console.log("Marketplace:", marketplace.target);

  // Marketplace должен уметь slash'ить и записывать рейтинг в Reputation
  const SLASH_ROLE = await reputation.SLASH_ROLE();
  const RATER_ROLE = await reputation.RATER_ROLE();
  await (await reputation.grantRole(SLASH_ROLE, marketplace.target)).wait();
  await (await reputation.grantRole(RATER_ROLE, marketplace.target)).wait();
  console.log("Granted SLASH_ROLE and RATER_ROLE to Marketplace");

  if (hasTestWallets) {
    const providerFunding = hre.ethers.parseEther("5000");
    const clientFunding = hre.ethers.parseEther("2000");
    await (await token.transfer(providerWallet.address, providerFunding)).wait();
    await (await token.transfer(clientWallet.address, clientFunding)).wait();
    console.log("Funded provider/client wallets with GPURENT");
  } else {
    console.log("Skipping provider/client funding: only one signer available.");
    console.log("Чтобы налить тестовых токенов на чужой адрес — позови token.transfer(<addr>, amount) отдельным скриптом.");
  }

  const addresses = {
    chainId: Number(network.chainId),
    network: hre.network.name,
    deployer: deployer.address,
    providerWallet: hasTestWallets ? providerWallet.address : null,
    clientWallet: hasTestWallets ? clientWallet.address : null,
    contracts: {
      GPURentalToken: token.target,
      ProviderReputation: reputation.target,
      Marketplace: marketplace.target
    },
    token: token.target,
    reputation: reputation.target,
    marketplace: marketplace.target
  };

  const outputDir = path.join(__dirname, "..", "local-chain");
  const abiDir = path.join(outputDir, "abi");
  fs.mkdirSync(abiDir, { recursive: true });

  const artifacts = [
    ["Marketplace", "contracts/Marketplace.sol:Marketplace"],
    ["GPURentalToken", "contracts/GPURentalToken.sol:GPURentalToken"],
    ["ProviderReputation", "contracts/ProviderReputation.sol:ProviderReputation"]
  ];
  for (const [name, qualifiedName] of artifacts) {
    const artifact = await hre.artifacts.readArtifact(qualifiedName);
    fs.writeFileSync(path.join(abiDir, `${name}.json`), JSON.stringify(artifact.abi, null, 2));
  }

  fs.writeFileSync(path.join(outputDir, "deployed-addresses.json"), JSON.stringify(addresses, null, 2));
  fs.writeFileSync("deployed-addresses.json", JSON.stringify(addresses, null, 2));
  console.log("Saved deployed-addresses.json and local-chain artifacts");
  if (hasTestWallets) {
    console.log("Provider wallet:", providerWallet.address);
    console.log("Client wallet:", clientWallet.address);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
