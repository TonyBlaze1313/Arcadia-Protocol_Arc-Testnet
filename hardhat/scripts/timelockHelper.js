#!/usr/bin/env node
/**
 * Timelock scheduling helper for ArcadiaTimelock (OpenZeppelin TimelockController)
 * Extended features:
 *  - schedule / execute single operation
 *  - schedule-batch / execute-batch
 *  - interactive mode (inquirer) to guide scheduling/execution
 *  - verify command: compute opId and poll until ready/done
 *
 * See script header comments in previous version for usage patterns.
 *
 * Important: This script focuses on preparing encoded calldata (ethers style) and scheduling/executing.
 * It expects you to run it from the hardhat folder (so deployed.json path is ../deployed.json) OR pass --timelock.
 */

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const ethers = hre.ethers;
const { BigNumber } = ethers;
const inquirer = require("inquirer");
const ora = require("ora");

function usageAndExit() {
  console.log(`
Timelock helper - commands:

  node timelockHelper.js hash --timelock <addr> --target <addr> --signature "fn(type1,type2)" --args '[arg1,arg2]' --delay <seconds> [--salt <hex>]
  node timelockHelper.js schedule --timelock <addr> --target <addr> --signature "fn(type1,type2)" --args '[arg1,arg2]' --delay <seconds> [--salt <hex>]
  node timelockHelper.js execute --timelock <addr> --target <addr> --signature "fn(type1,type2)" --args '[arg1,arg2]' --salt <hex>
  node timelockHelper.js schedule-batch --timelock <addr> --batch-file <path-to-json> --delay <seconds>
  node timelockHelper.js execute-batch --timelock <addr> --batch-file <path-to-json> --salt <hex>
  node timelockHelper.js verify --timelock <addr> --target <addr> --signature "fn(...)" --args '[...]' --salt <hex> --delay <seconds>
  node timelockHelper.js interactive --network <network>

Batch file format (JSON): an array of operations:
[
  { "target": "0x...", "signature": "grantRole(bytes32,address)", "args": ["0x...", "0x..."], "value": 0 },
  { "target": "0x...", "signature": "setFeeBps(uint16)", "args": [150], "value": 0 }
]

Examples:
  npx hardhat run scripts/timelockHelper.js schedule --target 0x... --signature "setFeeBps(uint16)" --args '[150]' --delay 172800 --network localhost
  npx hardhat run scripts/timelockHelper.js schedule-batch --batch-file ./batch.json --delay 0 --network localhost

`);
  process.exit(1);
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
      opts[k] = v;
    } else if (!opts._cmd) {
      opts._cmd = a;
    }
  }
  return opts;
}

function loadDeployedJson() {
  const p = path.join(__dirname, "..", "deployed.json");
  if (fs.existsSync(p)) {
    try {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (e) {}
  }
  return null;
}

function mkSalt(provided) {
  if (provided) {
    return provided.startsWith("0x") ? provided : ethers.hexlify(BigNumber.from(provided));
  }
  const salt = ethers.keccak256(ethers.toUtf8Bytes(String(Date.now()) + Math.random()));
  return salt;
}

function parseArgsJson(argsStr) {
  if (!argsStr) return [];
  try {
    const parsed = JSON.parse(argsStr);
    if (Array.isArray(parsed)) return parsed;
    return [parsed];
  } catch (e) {
    return argsStr.split(",").map((s) => {
      s = s.trim();
      if (/^0x/.test(s)) return s;
      if (/^\d+$/.test(s)) return BigNumber.from(s);
      try {
        return JSON.parse(s);
      } catch {
        return s;
      }
    });
  }
}

async function getTimelockAddress(opts) {
  if (opts.timelock) return opts.timelock;
  const d = loadDeployedJson();
  if (d && d.ArcadiaTimelock) return d.ArcadiaTimelock;
  throw new Error("timelock address not provided and hardhat/deployed.json missing ArcadiaTimelock");
}

const TIMELOCK_ABI = [
  "function schedule(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt, uint256 delay) external",
  "function execute(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt) payable external",
  "function getMinDelay() view returns (uint256)",
  "function hashOperation(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt) public pure returns (bytes32)",
  "function scheduleBatch(address[] targets, uint256[] values, bytes[] datas, bytes32 predecessor, bytes32 salt, uint256 delay) external",
  "function executeBatch(address[] targets, uint256[] values, bytes[] datas, bytes32 predecessor, bytes32 salt) payable external",
  "function isOperationPending(bytes32 id) view returns (bool)",
  "function isOperationReady(bytes32 id) view returns (bool)",
  "function isOperationDone(bytes32 id) view returns (bool)",
  "function hashOperationBatch(address[] targets, uint256[] values, bytes[] datas, bytes32 predecessor, bytes32 salt) public pure returns (bytes32)"
];

async function encodeDataFromSignature(signature, argsArray) {
  const iface = new ethers.Interface([`function ${signature}`]);
  const fnName = signature.split("(")[0];
  return iface.encodeFunctionData(fnName, argsArray);
}

async function cmdHash(opts) {
  const tlAddr = await getTimelockAddress(opts);
  const timelock = new ethers.Contract(tlAddr, TIMELOCK_ABI, ethers.provider);
  const target = opts.target;
  if (!target) throw new Error("missing --target");
  if (!opts.signature) throw new Error("missing --signature");
  const argsArray = parseArgsJson(opts.args);
  const data = await encodeDataFromSignature(opts.signature, argsArray);
  const predecessor = opts.predecessor || ethers.ZeroBytes32;
  const salt = mkSalt(opts.salt);
  const opId = await timelock.hashOperation(target, 0, data, predecessor, salt);
  console.log("operation id:", opId);
  console.log("salt:", salt);
  console.log("predecessor:", predecessor);
  console.log("raw data:", data);
  return { opId, salt, data, predecessor, target };
}

async function cmdSchedule(opts) {
  const signer = (await ethers.getSigners())[0];
  const tlAddr = await getTimelockAddress(opts);
  const timelock = new ethers.Contract(tlAddr, TIMELOCK_ABI, signer);
  const target = opts.target;
  if (!target) throw new Error("missing --target");
  if (!opts.signature) throw new Error("missing --signature");
  const argsArray = parseArgsJson(opts.args);
  const data = await encodeDataFromSignature(opts.signature, argsArray);
  const predecessor = opts.predecessor || ethers.ZeroBytes32;
  const salt = mkSalt(opts.salt);
  const delay = opts.delay ? parseInt(opts.delay) : (await timelock.getMinDelay()).toNumber();
  console.log("scheduling with delay (s):", delay);
  const tx = await timelock.schedule(target, 0, data, predecessor, salt, delay);
  console.log("tx hash:", tx.hash);
  const opId = await timelock.hashOperation(target, 0, data, predecessor, salt);
  console.log("operation id:", opId);
  console.log("salt:", salt);
  return { tx, opId, salt, data };
}

async function cmdExecute(opts) {
  const signer = (await ethers.getSigners())[0];
  const tlAddr = await getTimelockAddress(opts);
  const timelock = new ethers.Contract(tlAddr, TIMELOCK_ABI, signer);
  const target = opts.target;
  if (!target) throw new Error("missing --target");
  if (!opts.signature) throw new Error("missing --signature");
  if (!opts.salt) throw new Error("missing --salt (must match schedule salt)");
  const argsArray = parseArgsJson(opts.args);
  const data = await encodeDataFromSignature(opts.signature, argsArray);
  const predecessor = opts.predecessor || ethers.ZeroBytes32;
  const salt = opts.salt;
  console.log("executing operation with salt:", salt);
  const tx = await timelock.execute(target, 0, data, predecessor, salt, { value: 0 });
  console.log("tx hash:", tx.hash);
  console.log("Done (executed).");
  return tx;
}

async function cmdScheduleBatch(opts) {
  const signer = (await ethers.getSigners())[0];
  const tlAddr = await getTimelockAddress(opts);
  const timelock = new ethers.Contract(tlAddr, TIMELOCK_ABI, signer);

  let batch;
  if (opts["batch-file"]) {
    const p = path.isAbsolute(opts["batch-file"]) ? opts["batch-file"] : path.join(process.cwd(), opts["batch-file"]);
    batch = JSON.parse(fs.readFileSync(p, "utf8"));
  } else {
    throw new Error("missing --batch-file path");
  }

  // build arrays
  const targets = [];
  const values = [];
  const datas = [];

  for (const op of batch) {
    if (!op.target || !op.signature) throw new Error("each batch item must include target and signature");
    const args = op.args || [];
    const data = await encodeDataFromSignature(op.signature, args);
    targets.push(op.target);
    values.push(op.value ? BigNumber.from(op.value) : BigNumber.from(0));
    datas.push(data);
  }

  const predecessor = opts.predecessor || ethers.ZeroBytes32;
  const salt = mkSalt(opts.salt);
  const delay = opts.delay ? parseInt(opts.delay) : (await timelock.getMinDelay()).toNumber();
  console.log(`scheduling batch of ${targets.length} operations with delay ${delay}s`);
  const tx = await timelock.scheduleBatch(targets, values, datas, predecessor, salt, delay);
  console.log("tx hash:", tx.hash);
  const opId = await timelock.hashOperationBatch(targets, values, datas, predecessor, salt);
  console.log("batch op id:", opId);
  console.log("salt:", salt);
  return { tx, opId, salt };
}

async function cmdExecuteBatch(opts) {
  const signer = (await ethers.getSigners())[0];
  const tlAddr = await getTimelockAddress(opts);
  const timelock = new ethers.Contract(tlAddr, TIMELOCK_ABI, signer);

  let batch;
  if (opts["batch-file"]) {
    const p = path.isAbsolute(opts["batch-file"]) ? opts["batch-file"] : path.join(process.cwd(), opts["batch-file"]);
    batch = JSON.parse(fs.readFileSync(p, "utf8"));
  } else {
    throw new Error("missing --batch-file path");
  }

  // build arrays
  const targets = [];
  const values = [];
  const datas = [];

  for (const op of batch) {
    if (!op.target || !op.signature) throw new Error("each batch item must include target and signature");
    const args = op.args || [];
    const data = await encodeDataFromSignature(op.signature, args);
    targets.push(op.target);
    values.push(op.value ? BigNumber.from(op.value) : BigNumber.from(0));
    datas.push(data);
  }

  const predecessor = opts.predecessor || ethers.ZeroBytes32;
  if (!opts.salt) throw new Error("missing --salt (must match schedule salt)");
  const salt = opts.salt;
  console.log("executing batch with salt:", salt);
  const tx = await timelock.executeBatch(targets, values, datas, predecessor, salt, { value: 0 });
  console.log("tx hash:", tx.hash);
  console.log("Done.");
  return tx;
}

async function cmdVerify(opts) {
  const tlAddr = await getTimelockAddress(opts);
  const timelock = new ethers.Contract(tlAddr, TIMELOCK_ABI, ethers.provider);
  let opId;
  if (opts.opId) {
    opId = opts.opId;
  } else {
    // compute opId from target/signature/args
    if (!opts.target || !opts.signature || !opts.salt) throw new Error("provide opId OR target & signature & salt");
    const argsArray = parseArgsJson(opts.args);
    const data = await encodeDataFromSignature(opts.signature, argsArray);
    const predecessor = opts.predecessor || ethers.ZeroBytes32;
    opId = await timelock.hashOperation(opts.target, 0, data, predecessor, opts.salt);
  }

  const interval = opts.interval ? parseInt(opts.interval) : 5;
  const timeout = opts.timeout ? parseInt(opts.timeout) : 600; // default 10 minutes

  console.log(`verifying op ${opId} (poll every ${interval}s up to ${timeout}s)`);
  const spinner = ora('polling...').start();
  const start = Date.now();
  while (true) {
    const ready = await timelock.isOperationReady(opId);
    const done = await timelock.isOperationDone(opId);
    const pending = await timelock.isOperationPending(opId);
    spinner.text = `ready=${ready} pending=${pending} done=${done}`;
    if (ready) {
      spinner.succeed(`operation is ready to execute (opId=${opId})`);
      return { opId, ready: true, done, pending };
    }
    if (done) {
      spinner.succeed(`operation already done (opId=${opId})`);
      return { opId, ready: false, done: true, pending: false };
    }
    if ((Date.now() - start) / 1000 > timeout) {
      spinner.fail("timeout waiting for op ready");
      throw new Error("timeout");
    }
    await new Promise((r) => setTimeout(r, interval * 1000));
  }
}

async function cmdInteractive(opts) {
  console.log("Starting interactive timelock helper...");
  const answers = await inquirer.prompt([
    {
      type: "list",
      name: "action",
      message: "Select action",
      choices: [
        { name: "Schedule single operation", value: "schedule" },
        { name: "Execute single operation", value: "execute" },
        { name: "Schedule batch from file", value: "schedule-batch" },
        { name: "Execute batch from file", value: "execute-batch" },
        { name: "Verify operation readiness", value: "verify" },
        { name: "Compute opId (hash)", value: "hash" }
      ]
    },
    {
      type: "input",
      name: "timelock",
      message: "Timelock address (leave empty to use hardhat/deployed.json)",
      default: ""
    }
  ]);

  const baseOpts = { timelock: answers.timelock || undefined };

  if (answers.action === "schedule") {
    const detail = await inquirer.prompt([
      { type: "input", name: "target", message: "Target contract address" },
      { type: "input", name: "signature", message: "Function signature (e.g. setFeeBps(uint16))" },
      { type: "input", name: "args", message: "Args as JSON array (e.g. [150])", default: "[]" },
      { type: "input", name: "delay", message: "Delay in seconds (0 for local)", default: "0" },
      { type: "input", name: "salt", message: "Optional salt (hex) leave empty to generate", default: "" }
    ]);
    await cmdSchedule({ ...baseOpts, target: detail.target, signature: detail.signature, args: detail.args, delay: detail.delay, salt: detail.salt || undefined });
  } else if (answers.action === "execute") {
    const detail = await inquirer.prompt([
      { type: "input", name: "target", message: "Target contract address" },
      { type: "input", name: "signature", message: "Function signature" },
      { type: "input", name: "args", message: "Args as JSON array", default: "[]" },
      { type: "input", name: "salt", message: "Salt (hex) (must match schedule)", default: "" }
    ]);
    await cmdExecute({ ...baseOpts, target: detail.target, signature: detail.signature, args: detail.args, salt: detail.salt });
  } else if (answers.action === "schedule-batch") {
    const detail = await inquirer.prompt([
      { type: "input", name: "batchFile", message: "Batch JSON file path (relative)", default: "./batch.json" },
      { type: "input", name: "delay", message: "Delay in seconds (0 for local)", default: "0" },
      { type: "input", name: "salt", message: "Optional salt hex", default: "" }
    ]);
    await cmdScheduleBatch({ ...baseOpts, "batch-file": detail.batchFile, delay: detail.delay, salt: detail.salt || undefined });
  } else if (answers.action === "execute-batch") {
    const detail = await inquirer.prompt([
      { type: "input", name: "batchFile", message: "Batch JSON file path (relative)", default: "./batch.json" },
      { type: "input", name: "salt", message: "Salt hex (must match schedule)", default: "" }
    ]);
    await cmdExecuteBatch({ ...baseOpts, "batch-file": detail.batchFile, salt: detail.salt });
  } else if (answers.action === "verify") {
    const detail = await inquirer.prompt([
      { type: "input", name: "target", message: "Target contract address (if you don't have opId)" },
      { type: "input", name: "signature", message: "Function signature (if you don't have opId)", default: "" },
      { type: "input", name: "args", message: "Args as JSON array", default: "[]" },
      { type: "input", name: "salt", message: "Salt (hex)", default: "" },
      { type: "input", name: "interval", message: "Polling interval seconds", default: "5" },
      { type: "input", name: "timeout", message: "Timeout seconds", default: "600" }
    ]);
    await cmdVerify({ ...baseOpts, target: detail.target, signature: detail.signature, args: detail.args, salt: detail.salt, interval: detail.interval, timeout: detail.timeout });
  } else if (answers.action === "hash") {
    const detail = await inquirer.prompt([
      { type: "input", name: "target", message: "Target contract address" },
      { type: "input", name: "signature", message: "Function signature" },
      { type: "input", name: "args", message: "Args as JSON array", default: "[]" },
      { type: "input", name: "salt", message: "Optional salt", default: "" }
    ]);
    await cmdHash({ ...baseOpts, target: detail.target, signature: detail.signature, args: detail.args, salt: detail.salt });
  }
}

async function main() {
  const opts = parseArgs();
  const cmd = opts._cmd;
  if (!cmd) {
    // default to interactive if no command provided
    await cmdInteractive(opts);
    process.exit(0);
  }

  try {
    if (cmd === "hash") {
      await cmdHash(opts);
    } else if (cmd === "schedule") {
      await cmdSchedule(opts);
    } else if (cmd === "execute") {
      await cmdExecute(opts);
    } else if (cmd === "schedule-batch") {
      await cmdScheduleBatch(opts);
    } else if (cmd === "execute-batch") {
      await cmdExecuteBatch(opts);
    } else if (cmd === "verify") {
      await cmdVerify(opts);
    } else if (cmd === "interactive") {
      await cmdInteractive(opts);
    } else {
      console.error("unknown command:", cmd);
      usageAndExit();
    }
    process.exit(0);
  } catch (err) {
    console.error("error:", err.message || err);
    process.exit(1);
  }
}

main();
