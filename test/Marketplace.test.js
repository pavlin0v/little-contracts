const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Marketplace", function () {
  let token, marketplace, reputation, deployer, provider, renter, outsider;

  beforeEach(async function () {
    [deployer, provider, renter, outsider] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("GPURentalToken");
    token = await Token.deploy(deployer.address);
    await token.waitForDeployment();

    const Reputation = await ethers.getContractFactory("ProviderReputation");
    reputation = await Reputation.deploy(token.target);
    await reputation.waitForDeployment();

    const Marketplace = await ethers.getContractFactory("Marketplace");
    marketplace = await Marketplace.deploy(token.target, deployer.address, reputation.target);
    await marketplace.waitForDeployment();

    // Marketplace должен уметь slash'ить и записывать рейтинг
    const SLASH_ROLE = await reputation.SLASH_ROLE();
    const RATER_ROLE = await reputation.RATER_ROLE();
    await reputation.grantRole(SLASH_ROLE, marketplace.target);
    await reputation.grantRole(RATER_ROLE, marketplace.target);

    // финансирование provider и renter
    await token.connect(deployer).transfer(provider.address, ethers.parseEther("5000"));
    await token.connect(deployer).transfer(renter.address, ethers.parseEther("2000"));

    // provider стейкает, чтобы получить право листить
    await token.connect(provider).approve(reputation.target, ethers.parseEther("2000"));
    await reputation.connect(provider).stake(ethers.parseEther("1000"));
  });

  it("happy path: list -> book -> confirm -> payouts and fees", async function () {
    const price = ethers.parseEther("1"); // 1 токен в час
    await marketplace.connect(provider).listGPU(price, "QmSpec");

    await token.connect(renter).approve(marketplace.target, ethers.parseEther("10"));

    await expect(marketplace.connect(renter).bookGPU(0, 4)).to.emit(marketplace, "Booked");

    await ethers.provider.send("evm_increaseTime", [4 * 3600 + 10]);
    await ethers.provider.send("evm_mine");

    const treasuryBalanceBefore = await token.balanceOf(deployer.address);
    const deadBalanceBefore = await token.balanceOf("0x000000000000000000000000000000000000dEaD");
    const supplyBefore = await token.totalSupply();

    await expect(marketplace.connect(renter).confirmCompletion(0)).to.emit(marketplace, "BookingCompleted");

    const total = ethers.parseEther("4");
    const feeTotal = (total * 500n) / 10000n; // 0.2
    const treasuryShare = feeTotal / 2n;      // 0.1
    const burnShare = feeTotal - treasuryShare; // 0.1
    const providerShare = total - feeTotal;   // 3.8

    // провайдер получил долю
    const expectedProviderBalance =
      ethers.parseEther("5000") - ethers.parseEther("1000") + providerShare;
    expect(await token.balanceOf(provider.address)).to.equal(expectedProviderBalance);

    // treasury (deployer) получил свою часть
    expect(await token.balanceOf(deployer.address)).to.equal(treasuryBalanceBefore + treasuryShare);

    // burn реально сжёг (поскольку токен поддерживает burn), а не отправил на dead
    expect(await token.balanceOf("0x000000000000000000000000000000000000dEaD")).to.equal(deadBalanceBefore);
    expect(await token.totalSupply()).to.equal(supplyBefore - burnShare);
  });

  it("reverts listGPU when provider has no stake", async function () {
    await expect(
      marketplace.connect(outsider).listGPU(ethers.parseEther("1"), "QmSpec")
    ).to.be.revertedWith("insufficient stake");
  });

  it("reverts when booking without approval", async function () {
    await marketplace.connect(provider).listGPU(ethers.parseEther("1"), "QmSpec");
    await expect(marketplace.connect(renter).bookGPU(0, 1)).to.be.reverted;
  });

  it("reverts when booking zero hours", async function () {
    await marketplace.connect(provider).listGPU(ethers.parseEther("1"), "QmSpec");
    await token.connect(renter).approve(marketplace.target, ethers.parseEther("1"));
    await expect(marketplace.connect(renter).bookGPU(0, 0)).to.be.revertedWith("hours>0");
  });

  it("refundBooking slashes provider stake", async function () {
    const price = ethers.parseEther("1");
    await marketplace.connect(provider).listGPU(price, "QmSpec");
    await token.connect(renter).approve(marketplace.target, ethers.parseEther("10"));
    await marketplace.connect(renter).bookGPU(0, 2);

    const stakeBefore = await reputation.getStake(provider.address);
    const renterBalBefore = await token.balanceOf(renter.address);

    await marketplace.connect(renter).disputeBooking(0);
    await expect(marketplace.connect(deployer).refundBooking(0)).to.emit(marketplace, "Refunded");

    // 10% от 1000 = 100
    const expectedSlashed = (stakeBefore * 1000n) / 10000n;
    expect(await reputation.getStake(provider.address)).to.equal(stakeBefore - expectedSlashed);

    // деньги вернулись арендатору
    expect(await token.balanceOf(renter.address)).to.equal(renterBalBefore + ethers.parseEther("2"));

    const booking = await marketplace.bookings(0);
    expect(booking.status).to.equal(4n); // CANCELLED
  });

  describe("rateProvider", function () {
    async function bookAndConfirm(hours) {
      const price = ethers.parseEther("1");
      await marketplace.connect(provider).listGPU(price, "QmSpec");
      await token.connect(renter).approve(marketplace.target, ethers.parseEther("100"));
      await marketplace.connect(renter).bookGPU(0, hours);
      await marketplace.connect(renter).confirmCompletion(0);
    }

    it("happy path: renter rates after completion", async function () {
      await bookAndConfirm(1);
      await expect(marketplace.connect(renter).rateProvider(0, 5))
        .to.emit(marketplace, "ProviderRated")
        .withArgs(0, provider.address, 5);
      // среднее × 100 = 500
      expect(await reputation.getAverageRating(provider.address)).to.equal(500n);
    });

    it("reverts: not completed yet", async function () {
      const price = ethers.parseEther("1");
      await marketplace.connect(provider).listGPU(price, "QmSpec");
      await token.connect(renter).approve(marketplace.target, ethers.parseEther("10"));
      await marketplace.connect(renter).bookGPU(0, 1);
      await expect(marketplace.connect(renter).rateProvider(0, 5))
        .to.be.revertedWith("not completed");
    });

    it("reverts: caller is not the renter", async function () {
      await bookAndConfirm(1);
      await expect(marketplace.connect(outsider).rateProvider(0, 5))
        .to.be.revertedWith("only renter");
    });

    it("reverts: double rating", async function () {
      await bookAndConfirm(1);
      await marketplace.connect(renter).rateProvider(0, 5);
      await expect(marketplace.connect(renter).rateProvider(0, 5))
        .to.be.revertedWith("already rated");
    });

    it("averages across multiple bookings", async function () {
      // первая бронь
      const price = ethers.parseEther("1");
      await marketplace.connect(provider).listGPU(price, "QmSpec");
      await token.connect(renter).approve(marketplace.target, ethers.parseEther("100"));

      await marketplace.connect(renter).bookGPU(0, 1);
      await marketplace.connect(renter).confirmCompletion(0);
      await marketplace.connect(renter).rateProvider(0, 4);

      // вторая бронь по тому же листингу
      await marketplace.connect(renter).bookGPU(0, 1);
      await marketplace.connect(renter).confirmCompletion(1);
      await marketplace.connect(renter).rateProvider(1, 5);

      // (4+5)/2 = 4.5 → 450
      expect(await reputation.getAverageRating(provider.address)).to.equal(450n);
    });
  });
});
