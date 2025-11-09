import { useState, useEffect } from "react";
import { ethers } from "ethers";

/* Helper to verify eth-sign style signature (defunct) */
function recoverSignerFromOpId(opIdHex, signatureHex) {
  try {
    const messageBytes = ethers.getBytes(opIdHex);
    return ethers.verifyMessage(messageBytes, signatureHex);
  } catch (e) {
    try {
      return ethers.verifyMessage(opIdHex, signatureHex);
    } catch (err) {
      throw err;
    }
  }
}

export default function TimelockPanel() {
  const [signature, setSignature] = useState("");
  const [argsText, setArgsText] = useState("[]");
  const [target, setTarget] = useState("");
  const [adminKey, setAdminKey] = useState("");
  const [encoded, setEncoded] = useState("");
  const [opId, setOpId] = useState("");
  const [signedSig, setSignedSig] = useState("");
  const [signerKid, setSignerKid] = useState("");
  const [recoveredSigner, setRecoveredSigner] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    async function load() {
      try {
        const resp = await fetch("/deployed.json");
        if (resp.ok) {
          const j = await resp.json();
          if (j.ArcadiaTimelock) setTarget(j.ArcadiaTimelock);
        }
      } catch (e) {}
    }
    load();
  }, []);

  async function requestEncodeAndSign() {
    setError("");
    try {
      const args = JSON.parse(argsText || "[]");
      const body = { signature, args, target, value: 0, sign_opid: true };
      const resp = await fetch("/timelock/encode", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-ADMIN-KEY": adminKey },
        body: JSON.stringify(body)
      });
      const j = await resp.json();
      if (!resp.ok) {
        setError(j.detail || JSON.stringify(j));
        return;
      }
      setEncoded(j.data);
      setOpId(j.opId || "");
      setSignedSig(j.signature || "");
      setSignerKid(j.signer_kid || "");
      if (j.signature && j.opId) {
        try {
          const recovered = recoverSignerFromOpId(j.opId, j.signature);
          setRecoveredSigner(recovered);
        } catch (e) {
          setRecoveredSigner("verify failed: " + (e.message || e));
        }
      } else {
        setRecoveredSigner("");
      }
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="p-4 border rounded bg-white">
      <h3>Timelock - Encode & Signed opId</h3>
      <label>Target</label>
      <input className="input" value={target} onChange={(e)=>setTarget(e.target.value)} placeholder="timelock address" />
      <label>Function signature</label>
      <input className="input" value={signature} onChange={(e)=>setSignature(e.target.value)} placeholder="setFeeBps(uint16)" />
      <label>Args (JSON)</label>
      <input className="input" value={argsText} onChange={(e)=>setArgsText(e.target.value)} />
      <label>Admin API Key (backend mode)</label>
      <input className="input" value={adminKey} onChange={(e)=>setAdminKey(e.target.value)} />
      <div className="flex gap-2 mt-2">
        <button className="btn" onClick={requestEncodeAndSign}>Encode & sign_opid (backend)</button>
      </div>
      {error && <div className="mt-2 text-red-600">{error}</div>}
      {encoded && <div className="mt-2"><strong>Calldata:</strong><pre style={{whiteSpace:'pre-wrap'}}>{encoded}</pre></div>}
      {opId && <div className="mt-2"><strong>opId:</strong> <code>{opId}</code></div>}
      {signedSig && <div className="mt-2"><strong>backend signature:</strong> <code style={{wordBreak:'break-all'}}>{signedSig}</code></div>}
      {signerKid && <div className="mt-2"><strong>signer id (kid):</strong> {signerKid}</div>}
      {recoveredSigner && <div className="mt-2"><strong>recovered signer:</strong> {recoveredSigner}</div>}
    </div>
  );
}
