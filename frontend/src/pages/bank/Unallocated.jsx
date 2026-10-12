// UNALLOCATED PAYMENTS - a tab inside Bank & Reconciliation (no new sidebar entry).
// Money that came into the bank and is not (fully) against an invoice yet. Each line shows
// what was received, what is allocated, what is left, the client's open invoices (oldest due
// first) with the split the app suggests already ticked; ONE button approves it.
import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../../api';
import { money2, fmtD } from '../invoices/invFormat';
import './unallocated.css';

export default function Unallocated({ accountId, canManage, onChanged, onOpen }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [said, setSaid] = useState('');
  const [q, setQ] = useState('');
  const [client, setClient] = useState('');
  const [pick, setPick] = useState({}); // txnId -> { invoiceId: amountString }
  const [other, setOther] = useState({}); // txnId -> { clientId, rows }
  const [cross, setCross] = useState({});
  const [busy, setBusy] = useState('');
  const [clients, setClients] = useState(null);

  const load = useCallback(() => {
    const p = new URLSearchParams();
    if (accountId) p.set('bankAccountId', accountId);
    if (q) p.set('q', q);
    if (client) p.set('client', client);
    api.get(`/bank/unallocated?${p.toString()}`).then((r) => { setData(r.data); setErr(''); })
      .catch((e) => setErr(e.response?.data?.error || 'This list could not be loaded.'));
  }, [accountId, q, client]);
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q]);

  // Pre-tick the suggested split for every line the first time it is shown.
  useEffect(() => {
    if (!data) return;
    setPick((cur) => {
      const next = { ...cur };
      data.rows.forEach((r) => {
        if (next[r.txnId]) return;
        const m = {};
        ((r.suggested && r.suggested.parts) || []).forEach((x) => { m[x.invoiceId] = String(x.amount); });
        next[r.txnId] = m;
      });
      return next;
    });
  }, [data]);

  const loadClients = () => {
    if (clients) return;
    api.get('/bank/open-invoices').then((r) => {
      const m = new Map();
      r.data.rows.forEach((x) => { if (!m.has(x.clientId)) m.set(x.clientId, x.client); });
      setClients([...m.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)));
    }).catch(() => setClients([]));
  };
  useEffect(() => { if (canManage && data && data.rows.length) loadClients(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [data, canManage]);
  const chooseClient = (row, clientId) => {
    if (!clientId) { setOther((o) => ({ ...o, [row.txnId]: null })); return; }
    api.get(`/bank/open-invoices?clientId=${encodeURIComponent(clientId)}`).then((r) => {
      setOther((o) => ({ ...o, [row.txnId]: { clientId, rows: r.data.rows } }));
      const m = {};
      let left = Math.round(row.unallocated * 100);
      r.data.rows.forEach((x) => { const take = Math.min(left, Math.round(x.outstanding * 100)); if (take > 0) { m[x.id] = String(take / 100); left -= take; } });
      setPick((p) => ({ ...p, [row.txnId]: m }));
    });
  };

  const total = (id) => Object.values(pick[id] || {}).reduce((s, v) => s + Math.round((Number(v) || 0) * 100), 0) / 100;
  const toggle = (row, inv) => setPick((p) => {
    const m = { ...(p[row.txnId] || {}) };
    if (m[inv.id] !== undefined) delete m[inv.id];
    else {
      const left = Math.round((row.unallocated - total(row.txnId)) * 100) / 100;
      m[inv.id] = String(Math.max(0, Math.min(left, inv.outstanding)) || inv.outstanding);
    }
    return { ...p, [row.txnId]: m };
  });
  const setAmt = (row, inv, v) => setPick((p) => ({ ...p, [row.txnId]: { ...(p[row.txnId] || {}), [inv.id]: v } }));

  const approve = async (row) => {
    const parts = Object.entries(pick[row.txnId] || {}).map(([invoiceId, amount]) => ({ invoiceId, amount: Number(amount) })).filter((x) => x.amount > 0);
    setBusy(row.txnId); setErr(''); setSaid('');
    try {
      const res = await api.post(`/bank/${row.txnId}/allocate`, { parts, reason: 'Approved on Unallocated payments', confirmCrossClient: !!cross[row.txnId] });
      setSaid(`Done. ${money2(parts.reduce((s, x) => s + x.amount, 0))} allocated${res.data.unallocated > 0.004 ? `; ${money2(res.data.unallocated)} is still unallocated` : ''}.`);
      setPick((p) => { const n = { ...p }; delete n[row.txnId]; return n; });
      load();
      if (onChanged) onChanged();
    } catch (e) {
      const d = e.response?.data;
      setErr(d?.error || 'That did not work. Nothing was changed.');
      if (d?.code === 'CROSS_CLIENT') setCross((c) => ({ ...c, [row.txnId]: 'ask' }));
    } finally { setBusy(''); }
  };

  const facets = data?.facets?.client || [];
  const rows = data?.rows || [];
  const empty = useMemo(() => data && rows.length === 0, [data, rows]);

  return (
    <div className="ua-wrap">
      <div className="ua-intro">
        <b>Unallocated payments</b> - money received that is not against an invoice yet. Tick the invoices it pays and press <b>Approve</b>.
        <span className="small-muted"> {data ? data.policy : ''}</span>
      </div>
      {err && <div className="notice red" style={{ marginBottom: 8 }}><span>{err}</span></div>}
      {said && <div className="notice" style={{ marginBottom: 8 }}><span>{said}</span></div>}
      {data && (
        <div className="statbar">
          <div className="stat"><div className="n">{data.totals.lines}</div><div className="l">Payments waiting</div></div>
          <div className="stat"><div className="n">{money2(data.totals.received)}</div><div className="l">Received</div></div>
          <div className="stat"><div className="n">{money2(data.totals.allocated)}</div><div className="l">Already allocated</div></div>
          <div className="stat"><div className="n">{money2(data.totals.unallocated)}</div><div className="l">Left to allocate</div></div>
        </div>
      )}
      <div className="filter-row" style={{ alignItems: 'center' }}>
        <input className="ua-search" placeholder="Search narration, reference, client…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={client} onChange={(e) => setClient(e.target.value)} aria-label="Client">
          <option value="">All clients ({facets.reduce((s, f) => s + f.n, 0)})</option>
          {facets.map((f) => <option key={f.value} value={f.value}>{f.value} ({f.n})</option>)}
        </select>
      </div>
      {!data && !err && <div className="small-muted">Loading…</div>}
      {empty && <div className="card section">Nothing is waiting. Every payment that came in is against an invoice.</div>}
      {rows.map((r) => {
        const left = Math.round((r.unallocated - total(r.txnId)) * 100) / 100;
        const shown = other[r.txnId] ? other[r.txnId].rows : r.openInvoices;
        return (
          <div className="ua-card" key={r.txnId}>
            <div className="ua-head">
              <div>
                <b>{money2(r.unallocated)}</b> left of {money2(r.received)} · {fmtD(r.date)}{r.valueDate && r.valueDate !== r.date ? ` (value ${fmtD(r.valueDate)})` : ''}
                <div className="small-muted">{String(r.description).slice(0, 140)}{r.reference ? ` · ref ${r.reference}` : ''}</div>
                {r.partlyAllocated && <div className="small-muted">{money2(r.allocated)} of it is already against invoices.</div>}
              </div>
              <button type="button" className="link-btn" onClick={() => onOpen && onOpen(r.txnId)}>Details</button>
            </div>
            {r.reason && <div className="ua-why">{r.reason}</div>}
            <div className="ua-client">
              {r.client && !other[r.txnId] ? <span>Client: <b>{r.client}</b></span> : <span className="small-muted">Client not recognised from the narration.</span>}
              {canManage && (
                <select onFocus={loadClients} onChange={(e) => chooseClient(r, e.target.value)} value={other[r.txnId]?.clientId || ''} aria-label="Choose another client">
                  <option value="">{r.client ? 'Pay a different client…' : 'Choose the client…'}</option>
                  {(clients || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              )}
            </div>
            {shown.length === 0 ? <div className="small-muted">No open invoice to pick. Choose the client above.</div> : (
              <div className="tbl-wrap">
                <table>
                  <thead><tr><th /><th>Invoice</th><th>Candidate</th><th>Invoice date</th><th>Due</th><th className="num">Outstanding</th><th className="num">Pay now</th></tr></thead>
                  <tbody>
                    {shown.map((inv) => {
                      const on = (pick[r.txnId] || {})[inv.id] !== undefined;
                      return (
                        <tr key={inv.id}>
                          <td><input type="checkbox" checked={on} disabled={!canManage} onChange={() => toggle(r, inv)} aria-label={`Pay invoice ${inv.invoiceNumber}`} /></td>
                          <td>{inv.invoiceNumber}</td><td>{inv.candidate || '—'}</td><td>{fmtD(inv.invoiceDate)}</td><td>{inv.dueDate ? fmtD(inv.dueDate) : '—'}</td>
                          <td className="num">{money2(inv.outstanding)}</td>
                          <td className="num">{on ? <input type="number" step="0.01" min="0" max={inv.outstanding} value={(pick[r.txnId] || {})[inv.id]} onChange={(e) => setAmt(r, inv, e.target.value)} className="ua-amt" /> : '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {cross[r.txnId] && <label className="ua-cross"><input type="checkbox" checked={cross[r.txnId] === true} onChange={(e) => setCross((c) => ({ ...c, [r.txnId]: e.target.checked ? true : 'ask' }))} /> I confirm this money pays a different client than the one it came from</label>}
            {canManage && (
              <div className="ua-foot">
                <span className={left < -0.004 ? 'ua-bad' : 'small-muted'}>{left < -0.004 ? `${money2(-left)} too much ticked` : `${money2(total(r.txnId))} ticked · ${money2(left)} would stay unallocated`}</span>
                <button type="button" className="btn btn-primary" disabled={busy === r.txnId || total(r.txnId) <= 0 || left < -0.004} onClick={() => approve(r)}>
                  {busy === r.txnId ? 'Working…' : `Approve - allocate ${money2(total(r.txnId))}`}
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
