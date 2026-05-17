const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  // Получаем аккаунты и информацию о сети
  const [deployer, providerWallet, clientWallet] = await hre.ethers.getSigners();
  const network = await hre.ethers.provider.getNetwork();
  console.log("Deploying with", deployer.address);

  // Развертываем контракты
  // Развертываем наш токен и передаем адрес развертывающего в конструктор
  const Token = await hre.ethers.getContractFactory("GPURentalToken");
  const token = await Token.deploy(deployer.address);
  await token.waitForDeployment();
  console.log("Token:", token.target);

  // Развертываем контракт репутации, передавая адрес токена в конструктор
  const Reputation = await hre.ethers.getContractFactory("ProviderReputation");
  const reputation = await Reputation.deploy(token.target);
  await reputation.waitForDeployment();
  console.log("Reputation:", reputation.target);

  // Развертываем маркетплейс, передавая адреса токена и развертывающего в конструктор
  const Marketplace = await hre.ethers.getContractFactory("Marketplace");
  const marketplace = await Marketplace.deploy(token.target, deployer.address);
  await marketplace.waitForDeployment();
  console.log("Marketplace:", marketplace.target);

  // Выдаем роли провайдера и финансируем кошельки провайдера и клиента
  const providerRole = await marketplace.PROVIDER_ROLE();
  await (await marketplace.grantRole(providerRole, providerWallet.address)).wait();

  // Финансируем провайдера и клиента токенами для тестирования
  const providerFunding = hre.ethers.parseEther("5000");
  const clientFunding = hre.ethers.parseEther("2000");
  await (await token.transfer(providerWallet.address, providerFunding)).wait();
  await (await token.transfer(clientWallet.address, clientFunding)).wait();

  // Сохраняем адреса и ABI в JSON файлах
  const addresses = {
    chainId: Number(network.chainId),
    network: hre.network.name,
    deployer: deployer.address,
    providerWallet: providerWallet.address,
    clientWallet: clientWallet.address,
    contracts: {
      GPURentalToken: token.target,
      ProviderReputation: reputation.target,
      Marketplace: marketplace.target
    },
    token: token.target,
    reputation: reputation.target,
    marketplace: marketplace.target
  };

  // Сохраняем ABI и адреса в папке local-chain для использования в фронтенде
  const outputDir = path.join(__dirname, "..", "local-chain");
  const abiDir = path.join(outputDir, "abi");
  fs.mkdirSync(abiDir, { recursive: true });

  // Сохраняем ABI для каждого контракта
  const artifacts = [
    ["Marketplace", "contracts/Marketplace.sol:Marketplace"],
    ["GPURentalToken", "contracts/GPURentalToken.sol:GPURentalToken"],
    ["ProviderReputation", "contracts/ProviderReputation.sol:ProviderReputation"]
  ];
  for (const [name, qualifiedName] of artifacts) {
    const artifact = await hre.artifacts.readArtifact(qualifiedName);
    fs.writeFileSync(path.join(abiDir, `${name}.json`), JSON.stringify(artifact.abi, null, 2));
  }

  // Сохраняем адреса в корневой папке и в папке local-chain
  fs.writeFileSync(path.join(outputDir, "deployed-addresses.json"), JSON.stringify(addresses, null, 2));
  fs.writeFileSync("deployed-addresses.json", JSON.stringify(addresses, null, 2));
  console.log("Saved deployed-addresses.json and local-chain artifacts");
  console.log("Provider wallet:", providerWallet.address);
  console.log("Client wallet:", clientWallet.address);
  console.log("Chain ID:", Number(network.chainId));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
