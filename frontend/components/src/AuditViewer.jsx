import { useEffect, useState } from "react";

export default function AuditViewer() {
  const [adminKey, setAdminKey] = useState("");
  const [source, setSource] = useState("");
  const [items, setItems] = useState([]);
  const [selected, setSelected] = useState(null);
  const [content, setContent] = useState("");

  async function loadList() {
    const resp = await fetch("/audit/list", { headers: { "X-ADMIN-KEY": adminKey } });
    const j = await resp.json();
    if (!resp.ok) return alert("failed: " + (j.detail || JSON.stringify(j)));
    setSource(j.source);
    setItems(j.items || []);
  }

  async function loadItem(key) {
    const resp = await fetch("/audit/get?key=" + encodeURIComponent(key), { headers: { "X-ADMIN-KEY": adminKey } });
    const j = await resp.json();
    if (!resp.ok) return alert("failed: " + (j.detail || JSON.stringify(j)));
    setSelected(key);
    setContent(j.data);
  }

  return (
    <div className="p-4 border rounded bg-white">
      <h3 className="text-lg font-bold">Audit Viewer</h3>
      <div>
        <label>Admin API Key</label>
        <input className="input" value={adminKey} onChange={(e) => setAdminKey(e.target.value)} placeholder="X-ADMIN-KEY" />
        <button className="btn mt-2" onClick={loadList}>Load Audit List</button>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-3">
        <div className="col-span-1 border p-2 h-64 overflow-auto">
          <h4 className="font-semibold">Entries ({source})</h4>
          <ul>
            {items.map((it) => (
              <li key={it.key || it.index} className="mb-2">
                <button className="text-left" onClick={() => loadItem(it.key || it.index)}>{it.key || `entry ${it.index}`}</button>
                <div className="text-xs text-gray-500">{it.last_modified || it.preview}</div>
              </li>
            ))}
          </ul>
        </div>
        <div className="col-span-2 border p-2 h-64 overflow-auto">
          <h4 className="font-semibold">Selected ({selected})</h4>
          <pre style={{ whiteSpace: "pre-wrap" }}>{content}</pre>
        </div>
      </div>
    </div>
  );
}
