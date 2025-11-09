import TimelockPanel from '../components/TimelockPanel'
import AuditViewer from '../components/AuditViewer'

export default function Home(){
  return (
    <main className="p-8">
      <h1 className="text-3xl font-bold">Arcadia Protocol — Demo</h1>
      <p className="mt-4">Connect wallet, create invoice, pay invoice (Arc Testnet)</p>
      <div className="mt-6 grid grid-cols-1 gap-6">
        <div className="p-4 border rounded bg-white">
          <h2 className="font-semibold">Invoice demo (placeholder)</h2>
        </div>

        <div>
          <TimelockPanel />
        </div>

        <div>
          <AuditViewer />
        </div>
      </div>
    </main>
  )
}
