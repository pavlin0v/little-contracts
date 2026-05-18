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

    await token.connect(deployer).transfer(provider.address, ethers.parseEther("2000"));
    await token.connect(provider).approve(reputation.target, ethers.parseEther("2000"));
    await reputation.connect(provider).stake(ethers.parseEther("1000"));
    expect(await reputation.getStake(provider.address)).to.equal(ethers.parseEther("1000"));

    await reputation.slash(provider.address, ethers.parseEther("100"), "bad");
    expect(await reputation.getStake(provider.address)).to.equal(ethers.parseEther("900"));

    await expect(reputation.connect(provider).unStake(ethers.parseEther("100"))).to.be.revertedWith("unstake: locked");

    await ethers.provider.send("evm_increaseTime", [8 * 24 * 3600]);
    await ethers.provider.send("evm_mine");
    await reputation.connect(provider).unStake(ethers.parseEther("100"));
    expect(await reputation.getStake(provider.address)).to.equal(ethers.parseEther("800"));
  });

  it("slash fallback uses transfer to dead when burn not supported", async function () {
    const [deployer, provider] = await ethers.getSigners();
    const Mock = await ethers.getContractFactory("MockERC20");
    const mock = await Mock.deploy("Mock", "MCK", ethers.parseEther("10000"), deployer.address);
    await mock.waitForDeployment();

    const Reputation = await ethers.getContractFactory("ProviderReputation");
    const reputation = await Reputation.deploy(mock.target);
    await reputation.waitForDeployment();

    await mock.connect(deployer).transfer(provider.address, ethers.parseEther("2000"));
    await mock.connect(provider).approve(reputation.target, ethers.parseEther("2000"));
    await reputation.connect(provider).stake(ethers.parseEther("1000"));

    await reputation.slash(provider.address, ethers.parseEther("100"), "bad");
    expect(await mock.balanceOf("0x000000000000000000000000000000000000dead")).to.equal(ethers.parseEther("100"));
  });

  describe("slashForDispute", function () {
    let token, reputation, deployer, provider, marketplace;

    beforeEach(async function () {
      [deployer, provider, marketplace] = await ethers.getSigners();
      const Token = await ethers.getContractFactory("GPURentalToken");
      token = await Token.deploy(deployer.address);
      await token.waitForDeployment();

      const Reputation = await ethers.getContractFactory("ProviderReputation");
      reputation = await Reputation.deploy(token.target);
      await reputation.waitForDeployment();

      await token.connect(deployer).transfer(provider.address, ethers.parseEther("2000"));
      await token.connect(provider).approve(reputation.target, ethers.parseEther("2000"));
      await reputation.connect(provider).stake(ethers.parseEther("1000"));

      const SLASH_ROLE = await reputation.SLASH_ROLE();
      await reputation.grantRole(SLASH_ROLE, marketplace.address);
    });

    it("computes amount from slashBps (default 10%)", async function () {
      await reputation.connect(marketplace).slashForDispute(provider.address);
      expect(await reputation.getStake(provider.address)).to.equal(ethers.parseEther("900"));
    });

    it("respects updated slashBps", async function () {
      await reputation.connect(deployer).setSlashBps(2500); // 25%
      await reputation.connect(marketplace).slashForDispute(provider.address);
      expect(await reputation.getStake(provider.address)).to.equal(ethers.parseEther("750"));
    });

    it("returns 0 when provider has no stake (no revert)", async function () {
      const [, , , noStake] = await ethers.getSigners();
      const tx = await reputation.connect(marketplace).slashForDispute(noStake.address);
      await tx.wait();
      expect(await reputation.getStake(noStake.address)).to.equal(0n);
    });

    it("reverts when caller lacks SLASH_ROLE", async function () {
      await expect(reputation.connect(provider).slashForDispute(provider.address)).to.be.reverted;
    });
  });

  describe("recordRating + getAverageRating", function () {
    let token, reputation, deployer, provider, rater, outsider;

    beforeEach(async function () {
      [deployer, provider, rater, outsider] = await ethers.getSigners();
      const Token = await ethers.getContractFactory("GPURentalToken");
      token = await Token.deploy(deployer.address);
      await token.waitForDeployment();

      const Reputation = await ethers.getContractFactory("ProviderReputation");
      reputation = await Reputation.deploy(token.target);
      await reputation.waitForDeployment();

      const RATER_ROLE = await reputation.RATER_ROLE();
      await reputation.grantRole(RATER_ROLE, rater.address);
    });

    it("rejects non-RATER caller", async function () {
      await expect(reputation.connect(outsider).recordRating(provider.address, 5)).to.be.reverted;
    });

    it("rejects out-of-range scores", async function () {
      await expect(reputation.connect(rater).recordRating(provider.address, 0)).to.be.revertedWith("rating: out of range");
      await expect(reputation.connect(rater).recordRating(provider.address, 6)).to.be.revertedWith("rating: out of range");
    });

    it("returns 0 when no ratings", async function () {
      expect(await reputation.getAverageRating(provider.address)).to.equal(0n);
    });

    it("computes average × 100", async function () {
      await reputation.connect(rater).recordRating(provider.address, 4);
      await reputation.connect(rater).recordRating(provider.address, 5);
      expect(await reputation.getAverageRating(provider.address)).to.equal(450n);
    });
  });

  describe("setSlashBps", function () {
    it("admin only", async function () {
      const [deployer, other] = await ethers.getSigners();
      const Token = await ethers.getContractFactory("GPURentalToken");
      const token = await Token.deploy(deployer.address);
      await token.waitForDeployment();
      const Reputation = await ethers.getContractFactory("ProviderReputation");
      const reputation = await Reputation.deploy(token.target);
      await reputation.waitForDeployment();

      await expect(reputation.connect(other).setSlashBps(2000)).to.be.reverted;
      await expect(reputation.connect(deployer).setSlashBps(10001)).to.be.revertedWith("bps: too high");
      await reputation.connect(deployer).setSlashBps(2000);
      expect(await reputation.slashBps()).to.equal(2000n);
    });
  });
});
