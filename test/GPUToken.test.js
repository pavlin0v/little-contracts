const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("GPURentalToken", function () {
  it("deploys and mints initial supply to treasury", async function () {
    const [deployer, treasury, user] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("GPURentalToken");
    const token = await Token.deploy(treasury.address);
    await token.waitForDeployment();

    const supply = await token.totalSupply();
    expect(await token.balanceOf(treasury.address)).to.equal(supply);

    // burn works
    await token.connect(treasury).transfer(user.address, ethers.parseEther("1000"));
    await token.connect(user).burn(ethers.parseEther("100"));
    expect(await token.balanceOf(user.address)).to.equal(ethers.parseEther("900"));
  });
});
