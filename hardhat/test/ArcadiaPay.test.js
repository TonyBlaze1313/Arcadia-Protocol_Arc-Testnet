const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ArcadiaPay (timelock-aware)", function () {
  let deployer, payer, issuer, receiver;
  let usdc, vault, pay;

  beforeEach(async function () {
    [deployer, payer, issuer, receiver] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDC.deploy();
    await usdc.deployed();

    // mint some tokens to payer
    const decimals = await usdc.decimals();
    await usdc.mint(payer.address, ethers.BigNumber.from("1000000").mul(ethers.BigNumber.from(10).pow(decimals)));

    const Vault = await ethers.getContractFactory("ArcadiaVault");
    // for tests, use deployer as initial admin (rather than a timelock) to keep tests simple
    vault = await Vault.deploy(deployer.address);
    await vault.deployed();

    const Pay = await ethers.getContractFactory("ArcadiaPay");
    // likewise pass deployer.address as initialAdmin for Pay in tests
    pay = await Pay.deploy(deployer.address, vault.address, 100); // 1% fee
    await pay.deployed();
  });

  it("create -> pay -> release flow with fee routed to vault", async function () {
    // issuer creates invoice
    await expect(pay.connect(issuer).createInvoice(payer.address, usdc.address, ethers.utils.parseUnits("100", await usdc.decimals()), "ipfs://meta"))
      .to.emit(pay, "InvoiceCreated");

    const id = 1;

    // payer approves and pays
    await usdc.connect(payer).approve(pay.address, ethers.utils.parseUnits("100", await usdc.decimals()));
    await expect(pay.connect(payer).payInvoice(id)).to.emit(pay, "InvoicePaid");

    // fee (1%) should have been forwarded to vault
    const feeAmount = ethers.utils.parseUnits("1", await usdc.decimals()); // 1 USDC = 1% of 100
    const vaultBalance = await usdc.balanceOf(vault.address);
    expect(vaultBalance).to.equal(feeAmount);

    // release by issuer to receiver
    await expect(pay.connect(issuer).releaseFunds(id, receiver.address)).to.emit(pay, "InvoiceReleased");

    const receiverBalance = await usdc.balanceOf(receiver.address);
    const expectedNet = ethers.utils.parseUnits("99", await usdc.decimals()); // 100 - 1
    expect(receiverBalance).to.equal(expectedNet);
  });
});
