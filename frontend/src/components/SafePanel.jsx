import { useState, useEffect } from "react";
import { ethers } from "ethers";

/*
SafePanel
- Helps build a Gnosis Safe multisig transaction payload
- Can request backend to propose to a Safe Transaction Service (if SAFE_SERVICE_URL configured)
- Returns payload for offline signature/proposal if service not configured
- For testnet simplicity: when not integrated with a Safe service, the panel returns the JSON payload that multisig owners can sign offline via their workflows.
*/

export default function SafePanel() {
  const [safeAddress, setSafeAddress] = useState(process.env.NEXT_PUBLIC_SAFE_ADDRESS || "");
  const [to, setTo] = useState("");
  const [signature, setSignature] = useState("");
  const [argsText, setArgsText] = useState("[]");
  const [value, setValue] = useState("0");
  const [operation, setOperation] = useState("0");
  const [salt, setSalt] = useState("");
  const [adminKey, setAdminKey] = useState("");
  const [batchMode, setBatchMode] = useState(false);
  const [payload, setPayload] = useState(null);

  useEffect(() => {
    async function fetchDeployed() {
      try {
        const resp = await fetch("/deployed.json");
        if (!resp.ok) return;
        const j = await resp.json();
        if (j.ArcadiaTimelock) {
          // no-op; safeAddress not present
        }
        if (j.ArcadiaPay && !to) setTo(j.ArcadiaPay);
      } catch (e) {}
    }
    fetchDeployed();
  }, []);

  async function buildDataAndPropose() {
    try {
      // call backend encode to get calldata
      const body = { signature, args: JSON.parse(argsText || "[]") };
      const respEnc = await fetch("/timelock/encode", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(body) });
      const jEnc = await respEnc.json();
      if (!respEnc.ok) throw new Error(jEnc.detail || "encode failed");
      const data = jEnc.data;

      const bodySafe = {
        safe_address: safeAddress,
        to,
        value: parseInt(value || "0"),
        data,
        operation: parseInt(operation || "0"),
        nonce: null
      };

      const resp = await fetch("/safe/propose", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-ADMIN-KEY": adminKey },
        body: JSON.stringify(bodySafe)
      });
      const j = await resp.json();
      if (!resp.ok) {
        alert("Error proposing: " + JSON.stringify(j));
        return;
      }
      setPayload(j.payload || j);
      if (j.posted) {
        alert("Proposed to Safe service, response: " + JSON.stringify(j.response));
      } else {
        alert("Safe payload ready (not posted). Use payload for multisig flow.");
      }
    } catch (e) {
      alert("Error: " + (e.message || e));
    }
  }

  return (
    <div className="p-4 border rounded bg-white">
      <h3 className="text-xl font-bold">Gnosis Safe Proposal Panel</h3>

      <div className="mt-2">
        <label>Safe Address</label>
        <input value={safeAddress} onChange={(e) => setSafeAddress(e.target.value)} className="input" placeholder="0x..." />
      </div>

      <div className="mt-2">
        <label>Target (to)</label>
        <input value={to} onChange={(e) => setTo(e.target.value)} className="input" placeholder="contract address" />
        <label>Function signature</label>
        <input value={signature} onChange={(e) => setSignature(e.target.value)} className="input" placeholder="setFeeBps(uint16)" />
        <label>Args (JSON array)</label>
        <input value={argsText} onChange={(e) => setArgsText(e.target.value)} className="input" />
        <label>Value (wei)</label>
        <input value={value} onChange={(e) => setValue(e.target.value)} className="input" />
        <label>Operation (0 = CALL, 1 = DELEGATECALL)</label>
        <input value={operation} onChange={(e) => setOperation(e.target.value)} className="input" />
        <label>Admin API Key (for backend propose)</label>
        <input value={adminKey} onChange={(e) => setAdminKey(e.target.value)} className="input" />
        <div className="mt-2 flex gap-2">
          <button onClick={buildDataAndPropose} className="btn">Build & Propose</button>
        </div>
      </div>

      {payload && (
        <div className="mt-3 p-2 bg-gray-50 border">
          <h4 className="font-semibold">Resulting payload</h4>
          <pre style={{whiteSpace:'pre-wrap',wordBreak:'break-all'}}>{JSON.stringify(payload, null, 2)}</pre>
          <div className="mt-2">Use this payload with your Gnosis Safe multisig UI or submit to a Safe Transaction Service where available.</div>
        </div>
      )}
    </div>
  );
}
