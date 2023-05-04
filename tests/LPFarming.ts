import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import chai from "chai";
import { solidity } from "ethereum-waffle";
import { ethers, network } from "hardhat";
import { JPEG, LPFarming, TestERC20 } from "../types";
import { units, mineBlocks, checkAlmostSame } from "./utils";

const { expect } = chai;

chai.use(solidity);

describe("LPFarming", () => {
  let owner: SignerWithAddress,
    alice: SignerWithAddress,
    bob: SignerWithAddress,
    contract: SignerWithAddress;
  let jpeg: JPEG, farming: LPFarming;
  let lpTokens: TestERC20[] = [];

  beforeEach(async () => {
    const accounts = await ethers.getSigners();
    owner = accounts[0];
    alice = accounts[1];
    bob = accounts[2];
    contract = accounts[4];

    await network.provider.send("hardhat_setCode", [contract.address, "0xab"]); //simulate a contract

    const JPEG = await ethers.getContractFactory("JPEG");
    jpeg = await JPEG.deploy(units(1000000000)); // 1B JPEG'd
    await jpeg.deployed();

    const LPFarming = await ethers.getContractFactory("LPFarming");
    farming = await LPFarming.deploy(jpeg.address); // 100 JPEG per block
    await farming.deployed();

    const TestERC20 = await ethers.getContractFactory("TestERC20");

    lpTokens = [];
    for (let i = 0; i < 3; i++) {
      const token = await TestERC20.deploy(
        "Test Token " + i.toString(),
        "tAsset" + i.toString()
      );
      await token.deployed();

      await token.mint(owner.address, units(10000));

      lpTokens.push(token);
    }

    await jpeg.approve(farming.address, units(1000000));
  });

  it("should not allow the owner to renounce ownership", async () => {
    await expect(farming.renounceOwnership()).to.be.revertedWith(
      "Cannot renounce ownership"
    );
  });

  it("only owner can add pools", async () => {
    await expect(
      farming.connect(alice).add(10, lpTokens[0].address)
    ).to.revertedWith("");

    await farming.add(10, lpTokens[0].address);
    await farming.add(20, lpTokens[1].address);
    await farming.add(30, lpTokens[2].address);

    expect(await farming.poolLength()).to.equal(3);

    let pool = await farming.poolInfo(0);
    expect(pool.lpToken).to.equal(lpTokens[0].address);
    expect(pool.allocPoint).to.equal(10);
    pool = await farming.poolInfo(1);
    expect(pool.lpToken).to.equal(lpTokens[1].address);
    expect(pool.allocPoint).to.equal(20);
    pool = await farming.poolInfo(2);
    expect(pool.lpToken).to.equal(lpTokens[2].address);
    expect(pool.allocPoint).to.equal(30);
  });

  it("only owner can update pool configuration", async () => {
    await farming.add(10, lpTokens[0].address);

    let pool = await farming.poolInfo(0);
    expect(pool.lpToken).to.equal(lpTokens[0].address);
    expect(pool.allocPoint).to.equal(10);

    await expect(farming.connect(alice).set(0, 20)).to.revertedWith("");
    await farming.set(0, 20);

    pool = await farming.poolInfo(0);
    expect(pool.lpToken).to.equal(lpTokens[0].address);
    expect(pool.allocPoint).to.equal(20);

    await farming.set(0, 10);
    await farming.set(0, 10);

    pool = await farming.poolInfo(0);
    expect(pool.lpToken).to.equal(lpTokens[0].address);
    expect(pool.allocPoint).to.equal(10);
  });

  it("should not allow an epoch with invalid parameters", async () => {
    await expect(farming.newEpoch(0, 0, 0)).to.be.revertedWith(
      "Invalid start block"
    );
    let blockNumber = await ethers.provider.getBlockNumber();
    await expect(
      farming.newEpoch(blockNumber + 1, blockNumber + 1, 0)
    ).to.be.revertedWith("Invalid end block");
    blockNumber = await ethers.provider.getBlockNumber();
    await expect(
      farming.newEpoch(blockNumber + 1, blockNumber + 2, 0)
    ).to.be.revertedWith("Invalid reward per block");
  });

  it("should update epoch", async () => {
    let blockNumber = await ethers.provider.getBlockNumber();
    await farming.newEpoch(blockNumber + 1, blockNumber + 11, 100);
    expect(await jpeg.balanceOf(farming.address)).to.equal(1000);

    await mineBlocks(4);
    blockNumber = await ethers.provider.getBlockNumber();
    await farming.newEpoch(blockNumber + 1, blockNumber + 11, 100);
    expect(await jpeg.balanceOf(farming.address)).to.equal(1500);

    await mineBlocks(4);
    blockNumber = await ethers.provider.getBlockNumber();
    await farming.newEpoch(blockNumber + 1, blockNumber + 11, 50);
    expect(await jpeg.balanceOf(farming.address)).to.equal(1500);

    await mineBlocks(4);
    blockNumber = await ethers.provider.getBlockNumber();
    await farming.newEpoch(blockNumber + 1, blockNumber + 2, 100);
    expect(await jpeg.balanceOf(farming.address)).to.equal(1350);
  });

  it("should not emit tokens outside of an epoch", async () => {
    await farming.add(10, lpTokens[0].address);
    await lpTokens[0].approve(farming.address, units(1000));
    await farming.deposit(0, units(1000));
    await mineBlocks(1);
    expect(await farming.pendingReward(0, owner.address)).to.equal(0);
    await expect(farming.claim(0)).to.be.revertedWith("no_reward");
    await expect(farming.claimAll()).to.be.revertedWith("no_reward");
    const blockNumber = await ethers.provider.getBlockNumber();
    await farming.newEpoch(blockNumber + 2, blockNumber + 4, 1);
    await mineBlocks(1);
    expect(await farming.pendingReward(0, owner.address)).to.equal(0);
    await mineBlocks(1);
    expect(await farming.pendingReward(0, owner.address)).to.equal(1);
    await mineBlocks(1);
    expect(await farming.pendingReward(0, owner.address)).to.equal(2);
    await mineBlocks(1);
    expect(await farming.pendingReward(0, owner.address)).to.equal(2);
  });

  it("should not assing rewards in between epochs", async () => {
    await farming.add(10, lpTokens[0].address);
    await lpTokens[0].approve(farming.address, units(1000));
    await farming.deposit(0, units(1000));
    const blockNumber = await ethers.provider.getBlockNumber();
    await farming.newEpoch(blockNumber + 2, blockNumber + 4, 1);
    await mineBlocks(3);
    expect(await farming.pendingReward(0, owner.address)).to.equal(2);
    await farming.newEpoch(blockNumber + 8, blockNumber + 10, 1);
    await mineBlocks(4);
    expect(await farming.pendingReward(0, owner.address)).to.equal(3);
    await mineBlocks(1);
    expect(await farming.pendingReward(0, owner.address)).to.equal(4);
    await mineBlocks(1);
    expect(await farming.pendingReward(0, owner.address)).to.equal(4);
  });

  it("should not allow non whitelisted contracts to farm", async () => {
    await farming.add(10, lpTokens[0].address);
    await lpTokens[0].transfer(contract.address, units(1000));
    await lpTokens[0].connect(contract).approve(farming.address, units(1000));
    await expect(
      farming.connect(contract).deposit(0, units(1000))
    ).to.be.revertedWith("Contracts aren't allowed to farm");
  });

  it("should not allow 0 token deposits or withdrawals", async () => {
    await farming.add(10, lpTokens[0].address);
    await expect(farming.deposit(0, 0)).to.be.revertedWith("invalid_amount");
    await expect(farming.withdraw(0, 0)).to.be.revertedWith("invalid_amount");
    await expect(farming.withdraw(0, 1)).to.be.revertedWith(
      "insufficient_amount"
    );
  });

  it("should work for zero allocations", async () => {
    await farming.add(0, lpTokens[0].address);
    await lpTokens[0].approve(farming.address, units(1000));
    await farming.deposit(0, units(1000));
    await farming.withdraw(0, units(1000));
    await expect(farming.claim(0)).to.reverted;
  });

  it("should allow whitelisted contracts to farm", async () => {
    await farming.add(10, lpTokens[0].address);
    await lpTokens[0].transfer(contract.address, units(1000));
    await lpTokens[0].connect(contract).approve(farming.address, units(1000));
    await farming.setContractWhitelisted(contract.address, true);
    await farming.connect(contract).deposit(0, units(1000));
    await farming.connect(contract).withdraw(0, units(1000));
  });
});
