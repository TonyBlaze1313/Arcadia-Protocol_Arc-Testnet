const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying contracts with", deployer.address, "network:", hre.network.name);

  // Timelock / multisig settings (override with env for production)
  const MULTISIG = process.env.MULTISIG_ADDRESS || "";
  const TIMELOCK_DELAY = process.env.TIMELOCK_DELAY ? parseInt(process.env.TIMELOCK_DELAY) : (hre.network.name === "localhost" || hre.network.name === "hardhat" ? 0 : 2 * 24 * 3600); // 0s for local, 2 days default

  // Determine proposers and executors (use multisig if provided; otherwise deployer for dev)
  const proposers = MULTISIG ? [MULTISIG] : [deployer.address];
  const executors = MULTISIG ? [MULTISIG] : [deployer.address];

  console.log("Deploying Timelock (delay seconds):", TIMELOCK_DELAY);
  const Timelock = await hre.ethers.getContractFactory("ArcadiaTimelock");
  const timelock = await Timelock.deploy(TIMELOCK_DELAY, proposers, executors);
  await timelock.deployed();
  console.log("Timelock deployed to:", timelock.address);

  // If running on local/hardhat network, deploy a mock USDC for convenience
  let usdcAddress = process.env.USDC_ADDRESS;
  if (!usdcAddress || hre.network.name === "hardhat" || hre.network.name === "localhost") {
    console.log("Deploying MockUSDC for local environment...");
    const Mock = await hre.ethers.getContractFactory("MockUSDC");
    const mock = await Mock.deploy();
    await mock.deployed();
    usdcAddress = mock.address;
    console.log("MockUSDC deployed to:", usdcAddress);
  }

  // Deploy ArcadiaVault with the timelock as initial admin
  const ArcadiaVault = await hre.ethers.getContractFactory("ArcadiaVault");
  const vault = await ArcadiaVault.deploy(timelock.address);
  await vault.deployed();
  console.log("ArcadiaVault deployed to:", vault.address);

  // Deploy ArcadiaPay with timelock as initial admin, feeVault pointing to vault, and default feeBps=100 (1%)
  const ArcadiaPay = await hre.ethers.getContractFactory("ArcadiaPay");
  const pay = await ArcadiaPay.deploy(timelock.address, vault.address, 100);
  await pay.deployed();
  console.log("ArcadiaPay deployed to:", pay.address);

  // Persist addresses for frontend/backend consumption
  const out = {
    ArcadiaTimelock: timelock.address,
    ArcadiaPay: pay.address,
    ArcadiaVault: vault.address,
    USDC: usdcAddress,
    network: hre.network.name
  };
  const dest = path.join(__dirname, "..", "deployed.json");
  fs.writeFileSync(dest, JSON.stringify(out, null, 2));
  console.log("Wrote deployed addresses to", dest);

  console.log("=== DEPLOY SUMMARY ===");
  console.log("ArcadiaTimelock:", timelock.address);
  console.log("ArcadiaPay:", pay.address);
  console.log("ArcadiaVault:", vault.address);
  console.log("USDC:", usdcAddress);

  // NOTE: In production you should:
  //  - set MULTISIG_ADDRESS to your multisig and TIMELOCK_DELAY appropriately
  //  - use the timelock to schedule/execute role grants and other admin actions
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
