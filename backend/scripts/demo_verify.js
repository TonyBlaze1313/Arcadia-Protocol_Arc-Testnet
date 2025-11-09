#!/usr/bin/env node
// Demo verification script:
// Ensures backend fixture calldata decodes in ethers.js and client-side opId computation matches backend opId.
//
// Usage:
//   node backend/scripts/demo_verify.js backend/tests/fixtures/encode_samples.json

import fs from "fs";
import process from "process";
import { ethers } from "ethers";

function loadFixture(path) {
  const raw = fs.readFileSync(path, "utf8");
  return JSON.parse(raw);
}

function computeOpIdSingle(target, value, dataHex, predecessorHex, saltHex) {
  const abiCoder = new ethers.AbiCoder.defaultAbiCoder();
  const innerHash = ethers.keccak256(dataHex);
  const predecessor = predecessorHex || ethers.ZeroBytes32;
  let salt = saltHex;
  if (!salt) {
    const packed = abiCoder.encode(["bytes","address","uint256","bytes32"], [dataHex, target, value, predecessor]);
    salt = ethers.keccak256(packed);
  }
  const encoded = abiCoder.encode(["address","uint256","bytes32","bytes32","bytes32"], [target, value, innerHash, predecessor, salt]);
  const opId = ethers.keccak256(encoded);
  return { opId, salt };
}

function computeOpIdBatch(targets, values, datasHex, predecessorHex, saltHex) {
  const abiCoder = new ethers.AbiCoder.defaultAbiCoder();
  const predecessor = predecessorHex || ethers.ZeroBytes32;
  const bytesArr = datasHex.map(d => ethers.getBytes(d));
  const concat = ethers.concat(bytesArr);
  const packedHash = ethers.keccak256(concat);
  let salt = saltHex;
  if (!salt) {
    const encoded = abiCoder.encode(["address[]","uint256[]","bytes32","bytes32"], [targets, values, packedHash, predecessor]);
    salt = ethers.keccak256(encoded);
  }
  const encodedTop = abiCoder.encode(["address[]","uint256[]","bytes32","bytes32","bytes32"], [targets, values, packedHash, predecessor, salt]);
  const opId = ethers.keccak256(encodedTop);
  return { opId, salt };
}

async function main() {
  if (process.argv.length < 3) {
    console.error("usage: node demo_verify.js <fixture.json>");
    process.exit(1);
  }
  const fixturePath = process.argv[2];
  if (!fs.existsSync(fixturePath)) {
    console.error("fixture not found:", fixturePath);
    process.exit(1);
  }
  const fixture = loadFixture(fixturePath);
  console.log("Loaded fixture:", fixturePath);

  if (fixture.samples && fixture.batch) {
    const targets = fixture.batch.targets;
    const values = fixture.batch.values;
    const datasHex = fixture.samples.map(s => s.data);
    // decode each
    for (const s of fixture.samples) {
      const iface = new ethers.Interface([`function ${s.signature}`]);
      const fn = s.signature.split("(")[0];
      const decoded = iface.decodeFunctionData(fn, s.data);
      console.log(`Decoded ${fn}:`, decoded);
    }
    const { opId } = computeOpIdBatch(targets, values, datasHex, null, fixture.batch.salt_used);
    console.log("Backend batch opId (fixture):", fixture.batch.opId);
    console.log("Client-computed batch opId:", opId);
    process.exit(opId === fixture.batch.opId ? 0 : 2);
  } else if (fixture.mode === "single") {
    const sig = fixture.signature;
    const iface = new ethers.Interface([`function ${sig}`]);
    const fn = sig.split("(")[0];
    const decoded = iface.decodeFunctionData(fn, fixture.data);
    console.log("Decoded args:", decoded);
    const { opId } = computeOpIdSingle(fixture.target, fixture.value, fixture.data, null, fixture.salt_used);
    console.log("Backend opId:", fixture.opId);
    console.log("Client opId:", opId);
    process.exit(opId === fixture.opId ? 0 : 2);
  } else {
    console.error("unknown fixture format");
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
