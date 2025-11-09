import { useEffect, useState } from "react";
import { ethers } from "ethers";

// Replace with your deployed addresses or expose via NEXT_PUBLIC_*
const ARC_PAY_ADDRESS = process.env.NEXT_PUBLIC_ARCADIA_PAY_ADDRESS || "";
const USDC_ADDRESS = process.env.NEXT_PUBLIC_USDC_ADDRESS || "";
const ARC_PAY_ABI = [
  "function createInvoice(address payer, address token, uint256 amount, string metadataURI) returns (uint256)",
  "function payInvoice(uint256 id)",
  "event InvoiceCreated(uint256 indexed id, address indexed issuer, address indexed payer, uint256 amount, address token, string metadataURI)",
  "event InvoicePaid(uint256 indexed id, address indexed payer, uint256 amount, uint256 fee)"
];

export default function Dashboard() {
  const [provider, setProvider] = useState(null);
  const [signer, setSigner] = useState(null);
  const [account, setAccount] = useState("");
  const [invoices, setInvoices] = useState([]);
  const [payer, setPayer] = useState("");
  const [amount, setAmount] = useState("");

  useEffect(() => {
    if (typeof window !== "undefined" && window.ethereum) {
      const p = new ethers.BrowserProvider(window.ethereum);
      setProvider(p);
    }
  }, []);

  async function connect() {
    if (!provider) return;
    const accounts = await provider.send("eth_requestAccounts", []);
    setAccount(accounts[0]);
    const s = await provider.getSigner();
    setSigner(s);
  }

  async function createInvoice() {
    if (!signer || !ARC_PAY_ADDRESS) return alert("connect & set contract address");
    const contract = new ethers.Contract(ARC_PAY_ADDRESS, ARC_PAY_ABI, signer);
    const decimals = 6; // USDC typical; adjust
    const amt = ethers.parseUnits(amount || "0", decimals);
    const tx = await contract.createInvoice(payer, USDC_ADDRESS, amt, "ipfs://placeholder");
    await tx.wait();
    alert("invoice created (watch events for id)");
  }

  useEffect(() => {
    if (!provider || !ARC_PAY_ADDRESS) return;
    const ws = new ethers.WebSocketProvider(process.env.NEXT_PUBLIC_ARC_WS || process.env.NEXT_PUBLIC_ARC_RPC);
    const contract = new ethers.Contract(ARC_PAY_ADDRESS, ARC_PAY_ABI, ws);
    contract.on("InvoiceCreated", (id, issuer, payer, amt, token, metadata) => {
      setInvoices((prev) => [{ id: id.toString(), issuer, payer, amt: amt.toString(), token, metadata }, ...prev]);
    });
    contract.on("InvoicePaid", (id, payer, amt, fee) => {
      setInvoices((prev) =>
        prev.map((inv) => (inv.id === id.toString() ? { ...inv, paid: true, paidAmt: amt.toString(), fee: fee.toString() } : inv))
      );
    });
    return () => {
      try {
        contract.removeAllListeners("InvoiceCreated");
        contract.removeAllListeners("InvoicePaid");
      } catch (e) {}
    };
  }, [provider]);

  return (
    <div className="p-4">
      <h2 className="text-2xl font-bold">Arcadia Dashboard</h2>
      {!account ? <button onClick={connect} className="btn mt-3">Connect Wallet</button> : <div>Connected: {account}</div>}
      <div className="mt-4 p-4 border">
        <h3 className="font-semibold">Create Invoice</h3>
        <input placeholder="Payer address" value={payer} onChange={(e) => setPayer(e.target.value)} className="input" />
        <input placeholder="Amount (USDC)" value={amount} onChange={(e) => setAmount(e.target.value)} className="input" />
        <button onClick={createInvoice} className="btn">Create Invoice</button>
      </div>

      <div className="mt-6">
        <h3 className="font-semibold">Recent events</h3>
        <ul>
          {invoices.map((i) => (
            <li key={i.id} className="mb-2">
              #{i.id} issuer: {i.issuer} payer: {i.payer} amount: {i.amt} {i.paid ? "✅ paid" : ""}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
