// AS PER THE GST PORTAL vs AS PER OUR BOOKS, month by month (founder 2026-11-14, gst.xlsx).
// The portal side is the monthly figures filed on the GST portal (typed in / loaded from the sheet, never fetched); the books side
// is worked out from the invoices (invoice date, net of credit notes) and the bills. GET/PUT /office-expenses/gst-portal.
import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import { money } from './officeUtil';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const label = (k) => `${MON[Number(k.slice(5, 7)) - 1]} ${k.slice(0, 4)}`;
const FIELDS = [
  ['sTaxable', 'Sales taxable value'], ['sIgst', 'Sales IGST'], ['sCgst', 'Sales CGST'], ['sSgst', 'Sales SGST'],
  ['pTaxable', 'Purchases taxable value'], ['pIgst', 'Purchases IGST'], ['pCgst', 'Purchases CGST'], ['pSgst', 'Purchases SGST'],
];

const Diff = ({ v }) => {
  if (v == null) return <span className="small-muted">—</span>;
  if (Math.abs(v) < 1) return <span style={{ color: 'var(--green, #1a7f4b)' }}>0</span>;
  return <b style={{ color: 'var(--red, #b3261e)' }}>{v > 0 ? '+' : '−'}{money(Math.abs(v))}</b>;
};

function EditModal({ row, onClose, onSaved }) {
  const [v, setV] = useState(() => Object.fromEntries(FIELDS.map(([f]) => [f, row.portal ? String(row.portal[f] ?? 0) : ''])));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const save = async () => {
    setBusy(true); setErr('');
    try { await api.put('/office-expenses/gst-portal', { month: row.month, ...v }); onSaved(); } catch (e) { setErr(e.response?.data?.error || 'Could not save.'); setBusy(false); }
  };
  const clear = async () => {
    setBusy(true); setErr('');
    try { await api.put('/office-expenses/gst-portal', { month: row.month, clear: true }); onSaved(); } catch (e) { setErr(e.response?.data?.error || 'Could not remove.'); setBusy(false); }
  };
  return (
    <Modal title={`GST portal figures · ${label(row.month)}`} note="As filed on the GST portal" onClose={onClose} size="wide"
      footer={(
        <>
          {row.portal && <button type="button" className="btn" onClick={clear} disabled={busy}>Remove this month</button>}
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </>
      )}>
      {err && <div className="notice red"><span>{err}</span></div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10 }}>
        {FIELDS.map(([f, l]) => (
          <label key={f} className="field" style={{ display: 'grid', gap: 4 }}>
            <span className="small-muted">{l}</span>
            <input type="number" min="0" step="0.01" value={v[f]} onChange={(e) => setV({ ...v, [f]: e.target.value })} />
          </label>
        ))}
      </div>
    </Modal>
  );
}

export default function GstPortalCompare({ period, canManage, reloadKey }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [edit, setEdit] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    api.get('/office-expenses/gst-portal', { params: { period } })
      .then((r) => { if (live) { setD(r.data); setErr(''); } })
      .catch((e) => { if (live) setErr(e.response?.data?.error || 'The GST portal comparison could not be loaded.'); });
    return () => { live = false; };
  }, [period, reloadKey, tick]);
  const saved = useCallback(() => { setEdit(null); setTick((t) => t + 1); }, []);

  if (err) return <div className="notice red"><span>{err}</span></div>;
  if (!d) return <div className="small-muted">Loading…</div>;
  const t = d.totals;
  const dS = t.booksFiledMonths.sTaxable - t.portal.sTaxable;
  const dG = t.booksFiledMonths.sGst - t.portal.sGst;

  return (
    <div className="gp" style={{ marginTop: 16 }}>
      <div className="gp-main">
        <div className="gp-hd">
          <div className="gp-hd-t">
            <b>As per the GST portal · month by month</b>
            <div className="gp-hd-s">
              What was filed on the GST portal against what our invoices and bills say. The portal figures are typed in from the filed returns
              {d.updatedBy ? ` (last changed by ${d.updatedBy})` : ''}; nothing is fetched from the portal. Sales follow the invoice date.
            </div>
          </div>
        </div>
        {t.filedMonths > 0 && (
          <div className="gp-cards">
            <div className="gp-card gp-blue"><div className="gp-card-l">Filed sales (taxable)</div><div className="gp-card-v">{money(t.portal.sTaxable)}</div><div className="gp-card-s">{t.filedMonths} filed month{t.filedMonths === 1 ? '' : 's'}</div></div>
            <div className="gp-card gp-gold"><div className="gp-card-l">Filed sales GST</div><div className="gp-card-v">{money(t.portal.sGst)}</div><div className="gp-card-s">IGST + CGST + SGST</div></div>
            <div className={`gp-card ${Math.abs(dS) < 1 ? 'gp-green' : 'gp-red'}`}><div className="gp-card-l">Books vs portal (taxable)</div><div className="gp-card-v">{Math.abs(dS) < 1 ? 'Matches' : `${dS > 0 ? '+' : '−'}${money(Math.abs(dS))}`}</div><div className="gp-card-s">same months only</div></div>
            <div className={`gp-card ${Math.abs(dG) < 1 ? 'gp-green' : 'gp-red'}`}><div className="gp-card-l">Books vs portal (GST)</div><div className="gp-card-v">{Math.abs(dG) < 1 ? 'Matches' : `${dG > 0 ? '+' : '−'}${money(Math.abs(dG))}`}</div><div className="gp-card-s">{dG > 0.5 ? 'books show more GST than was filed' : dG < -0.5 ? 'portal shows more GST than the books' : 'same months only'}</div></div>
          </div>
        )}
        <div className="gp-tbl" style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th rowSpan={2}>Month</th>
                <th colSpan={3} className="num">Sales · taxable value</th>
                <th colSpan={3} className="num">Sales · GST</th>
                <th colSpan={3} className="num">Purchases · GST (input)</th>
                {canManage && <th rowSpan={2} />}
              </tr>
              <tr>
                <th className="num">Portal</th><th className="num">Books</th><th className="num">Diff</th>
                <th className="num">Portal</th><th className="num">Books</th><th className="num">Diff</th>
                <th className="num">Portal</th><th className="num">Books</th><th className="num">Diff</th>
              </tr>
            </thead>
            <tbody>
              {d.rows.map((r) => (
                <tr key={r.month}>
                  <td><b>{label(r.month)}</b>{!r.filed && <div className="small-muted">not entered</div>}</td>
                  <td className="num">{r.portal ? money(r.portal.sTaxable) : '—'}</td>
                  <td className="num">{money(r.books.sTaxable)}<div className="small-muted">{r.books.invoices} inv</div></td>
                  <td className="num"><Diff v={r.diff && r.diff.sTaxable} /></td>
                  <td className="num">{r.portal ? money(r.portal.sGst) : '—'}</td>
                  <td className="num">{money(r.books.sGst)}</td>
                  <td className="num"><Diff v={r.diff && r.diff.sGst} /></td>
                  <td className="num">{r.portal ? money(r.portal.pGst) : '—'}</td>
                  <td className="num">{money(r.books.pGst)}<div className="small-muted">{r.books.bills} bills</div></td>
                  <td className="num"><Diff v={r.diff && r.diff.pGst} /></td>
                  {canManage && <td><button type="button" className="btn btn-sm gp-out" onClick={() => setEdit(r)}>{r.filed ? 'Edit' : 'Enter'}</button></td>}
                </tr>
              ))}
              {d.rows.length === 0 && <tr><td colSpan={canManage ? 11 : 10} className="empty-mini">No months in this period.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="small-muted" style={{ marginTop: 6 }}>
          Diff = books − portal. A plus means our books show more than was filed (an invoice may be missing from the return, or filed in another month);
          a minus means the portal shows more than the books.
        </div>
      </div>
      {edit && <EditModal row={edit} onClose={() => setEdit(null)} onSaved={saved} />}
    </div>
  );
}
