const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Marketplace", function () {
  let token, marketplace, reputation, deployer, provider, renter;

  beforeEach(async function () {
    [deployer, provider, renter] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("GPURentalToken");
    token = await Token.deploy(deployer.address);
    await token.waitForDeployment();

    const Reputation = await ethers.getContractFactory("ProviderReputation");
    reputation = await Reputation.deploy(token.target);
    await reputation.waitForDeployment();

    const Marketplace = await ethers.getContractFactory("Marketplace");
    marketplace = await Marketplace.deploy(token.target, deployer.address);
    await marketplace.waitForDeployment();

    // grant provider role
    await marketplace.grantRole(ethers.keccak256(ethers.toUtf8Bytes("PROVIDER_ROLE")), provider.address);

    // fund provider and renter
    await token.connect(deployer).transfer(provider.address, ethers.parseEther("5000"));
    await token.connect(deployer).transfer(renter.address, ethers.parseEther("2000"));

    // provider stakes on reputation to meet minStake
    await token.connect(provider).approve(reputation.target, ethers.parseEther("2000"));
    await reputation.connect(provider).stake(ethers.parseEther("1000"));
  });

  it("happy path: list -> book -> confirm -> payouts and fees", async function () {
    // provider lists
    const price = ethers.parseEther("1"); // 1 token per hour
    await marketplace.connect(provider).listGPU(price, "QmSpec");

    // renter approves marketplace
    await token.connect(renter).approve(marketplace.target, ethers.parseEther("10"));

    // book for 4 hours => 4 tokens
    const tx = await marketplace.connect(renter).bookGPU(0, 4);
    await expect(tx).to.emit(marketplace, "Booked");

    // fast-forward time
    await ethers.provider.send("evm_increaseTime", [4 * 3600 + 10]);
    await ethers.provider.send("evm_mine");

    // confirm completion
    await expect(marketplace.connect(renter).confirmCompletion(0)).to.emit(marketplace, "BookingCompleted");

    // check provider received provider share: initial 5000 - staked 1000 + providerShare
    const total = ethers.parseEther("4");
    const feeTotal = (total * 500n) / 10000n; // 5% of 4 = 0.2
    const providerShare = total - feeTotal;
    const expected = ethers.parseEther("5000") - ethers.parseEther("1000") + providerShare;
    expect(await token.balanceOf(provider.address)).to.equal(expected);
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

  it("dispute and admin refund flow", async function () {
    const price = ethers.parseEther("1");
    await marketplace.connect(provider).listGPU(price, "QmSpec");
    await token.connect(renter).approve(marketplace.target, ethers.parseEther("10"));
    await marketplace.connect(renter).bookGPU(0, 2);
    // renter raises dispute
    await marketplace.connect(renter).disputeBooking(0);
    // admin refunds
    await expect(marketplace.connect(deployer).refundBooking(0)).to.not.be.reverted;
    const booking = await marketplace.bookings(0);
    expect(booking.status).to.equal(4n); // CANCELLED
  });
});
