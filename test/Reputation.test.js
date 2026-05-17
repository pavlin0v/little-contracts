const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ProviderReputation", function () {
  it("stake and slash flow", async function () {
    const [deployer, provider] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("GPURentalToken");
    const token = await Token.deploy(deployer.address);
    await token.waitForDeployment();

    const Reputation = await ethers.getContractFactory("ProviderReputation");
    const reputation = await Reputation.deploy(token.target);
    await reputation.waitForDeployment();

    // fund provider
    await token.connect(deployer).transfer(provider.address, ethers.parseEther("2000"));
    await token.connect(provider).approve(reputation.target, ethers.parseEther("2000"));
    await reputation.connect(provider).stake(ethers.parseEther("1000"));
    expect(await reputation.getStake(provider.address)).to.equal(ethers.parseEther("1000"));

    // slash by admin
    await reputation.slash(provider.address, ethers.parseEther("100"), "bad");
    expect(await reputation.getStake(provider.address)).to.equal(ethers.parseEther("900"));

    // unstake locked -> should revert
    await expect(reputation.connect(provider).unStake(ethers.parseEther("100"))).to.be.revertedWith("unstake: locked");

    // increase time and unstake
    await ethers.provider.send("evm_increaseTime", [8 * 24 * 3600]);
    await ethers.provider.send("evm_mine");
    await reputation.connect(provider).unStake(ethers.parseEther("100"));
    expect(await reputation.getStake(provider.address)).to.equal(ethers.parseEther("800"));
  });

  it("slash fallback uses transfer to dead when burn not supported", async function () {
    const [deployer, provider] = await ethers.getSigners();
    const Mock = await ethers.getContractFactory("MockERC20");
    const mock = await Mock.deploy("Mock","MCK", ethers.parseEther("10000"), deployer.address);
    await mock.waitForDeployment();

    // deploy reputation with mock token (no burn)
    const Reputation = await ethers.getContractFactory("ProviderReputation");
    const reputation = await Reputation.deploy(mock.target);
    await reputation.waitForDeployment();

    // fund & stake
    await mock.connect(deployer).transfer(provider.address, ethers.parseEther("2000"));
    await mock.connect(provider).approve(reputation.target, ethers.parseEther("2000"));
    await reputation.connect(provider).stake(ethers.parseEther("1000"));

    // slash -> fallback should transfer to dead address
    await reputation.slash(provider.address, ethers.parseEther("100"), "bad");
    expect(await mock.balanceOf("0x000000000000000000000000000000000000dead")).to.equal(ethers.parseEther("100"));
  });
});
