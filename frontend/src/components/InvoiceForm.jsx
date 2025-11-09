import { useState } from 'react'
export default function InvoiceForm(){
  const [payer, setPayer] = useState('');
  const [amount, setAmount] = useState('');
  return (
    <form className="space-y-3">
      <input placeholder="Payer address" value={payer} onChange={e=>setPayer(e.target.value)} />
      <input placeholder="Amount (USDC)" value={amount} onChange={e=>setAmount(e.target.value)} />
      <button className="btn">Create Invoice</button>
    </form>
  )
}
