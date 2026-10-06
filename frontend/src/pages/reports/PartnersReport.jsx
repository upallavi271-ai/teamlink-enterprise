// ATS-100 B7 — ATS Reports → Partners. Per agency / freelancer: submitted,
// duplicates, screening, interviews, selected, joined, rejected, dropped,
// payout (fee before GST of approved / paid payouts) and cost per joining.
// Filters cascade on the server (each list counts only what the other
// filters leave); Excel downloads exactly what is shown.
// Backend: routes/partners.js GET /partners/report.
import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import { FacetSelect } from '../../components/ui/ListPageHeader.jsx';
import StatCard, { StatRow } from '../../components/ui/StatCard.jsx';
import { saveBlob } from '../office/officeUtil';
import { money } from '../invoices/invFormat';

const BLANK = { from: '', to: '', department: '', partnerId: '', clientId: '', type: '' };

export default function PartnersReport({ canExport }) {
  const [f, setF] = useState(BLANK);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [said, setSaid] = useState('');
  const [sort, setSort] = useState({ k: 'joined', dir: -1 });

  const load = useCallback(() => {
    api.get('/partners/report', { params: Object.fromEntries(Object.entries(f).filter(([, v]) => v)) })
      .then((r) => { setData(r.data); setError(''); })
      .catch((e) => setError(e.response?.data?.error || 'The partner report could not be loaded.'));
  }, [f]);
  useEffect(() => { load(); }, [load]);

  const exportXlsx = async () => {
    try {
      const res = await api.post('/partners/report/export.xlsx', f, { responseType: 'blob' });
      saveBlob(res, 'partner-performance.xlsx');
      setSaid('Downloaded.');
    } catch { setError('The Excel file could not be made.'); }
  };
  const rows = [...(data?.rows || [])].sort((a, b) => {
    const x = a[sort.k]; const y = b[sort.k];
    if (typeof x === 'string') return x.localeCompare(y) * sort.dir;
    return ((Number(x) || 0) - (Number(y) || 0)) * sort.dir;
  });
  const th = (k, label, num) => (
    <th className={num ? 'n' : ''} style={{ cursor: 'pointer', whiteSpace: 'nowrap', textAlign: num ? 'right' : undefined }} onClick={() => setSort({ k, dir: sort.k === k ? -sort.dir : (num ? -1 : 1) })}>
      {label}{sort.k === k ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}
    </th>
  );
  const t = data?.totals;
  const fac = data?.facets || {};

  return (
    <div>
      {error && <div className="notice red"><span>{error}</span></div>}
      {said && <div className="notice" role="status"><span>{said}</span></div>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <label className="lph-facet"><span className="lph-facet-lbl">From</span><input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></label>
        <label className="lph-facet"><span className="lph-facet-lbl">To</span><input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></label>
        <FacetSelect label="Department" value={f.department} allLabel="All departments" options={fac.department} onChange={(v) => setF({ ...f, department: v })} />
        <FacetSelect label="Partner" value={f.partnerId} allLabel="All partners" options={fac.partnerId} onChange={(v) => setF({ ...f, partnerId: v })} />
        <FacetSelect label="Client" value={f.clientId} allLabel="All clients" options={fac.clientId} onChange={(v) => setF({ ...f, clientId: v })} />
        <FacetSelect label="Type" value={f.type} allLabel="Agency + freelancer" options={fac.type} onChange={(v) => setF({ ...f, type: v })} />
        {Object.values(f).some(Boolean) && <button type="button" className="btn btn-sm" onClick={() => setF(BLANK)}>Clear</button>}
        <span style={{ flex: 1 }} />
        {canExport && <button type="button" className="btn btn-sm" disabled={!rows.length} onClick={exportXlsx}>Excel</button>}
      </div>

      {!data ? <div className="small-muted">Loading…</div> : (
        <>
          <StatRow>
            <StatCard label="Candidates sent" value={t.submitted} tone="blue" />
            <StatCard label="Duplicates (refused)" value={t.duplicates} tone={t.duplicates ? 'orange' : 'green'} hint={t.submitted ? `${Math.round((t.duplicates / t.submitted) * 100)}% of sent` : 'None yet'} />
            <StatCard label="In interview / selected" value={t.interviews + t.selected} tone="blue" />
            <StatCard label="Joined" value={t.joined} tone="green" hint={t.dropped ? `${t.dropped} dropped` : 'Nobody dropped'} />
            <StatCard label="Partner payout" value={money(t.payout)} tone="orange" hint="fee before GST, approved + paid" />
            <StatCard label="Cost per joining" value={t.costPerJoining == null ? '—' : money(t.costPerJoining)} tone="grey" />
          </StatRow>
          <div className="tbl-wrap" style={{ marginTop: 12 }}>
            <table className="cn-table">
              <thead>
                <tr>{th('partner', 'Partner')}{th('type', 'Type')}{th('submitted', 'Sent', true)}{th('duplicates', 'Duplicates', true)}{th('screening', 'Screening', true)}{th('interviews', 'Interviews', true)}{th('selected', 'Selected', true)}{th('joined', 'Joined', true)}{th('rejected', 'Rejected', true)}{th('dropped', 'Dropped', true)}{th('joinPct', 'Join %', true)}{th('payout', 'Payout', true)}{th('costPerJoining', 'Cost / joining', true)}</tr>
              </thead>
              <tbody>
                {!rows.length && <tr><td colSpan={13} className="small-muted">No partner submissions in this range. Partners send candidates from /partner-login once a job is shared with them.</td></tr>}
                {rows.map((r) => (
                  <tr key={r.partnerId}>
                    <td><b>{r.partner}</b>{r.status !== 'Active' && <span className="small-muted"> · {r.status}</span>}</td>
                    <td>{r.type}</td>
                    <td className="n" style={{ textAlign: 'right' }}>{r.submitted}</td>
                    <td className="n" style={{ textAlign: 'right' }}>{r.duplicates}{r.duplicates ? <span className="small-muted"> ({r.duplicatePct}%)</span> : null}</td>
                    <td className="n" style={{ textAlign: 'right' }}>{r.screening}</td>
                    <td className="n" style={{ textAlign: 'right' }}>{r.interviews}</td>
                    <td className="n" style={{ textAlign: 'right' }}>{r.selected}</td>
                    <td className="n" style={{ textAlign: 'right' }}><b>{r.joined}</b></td>
                    <td className="n" style={{ textAlign: 'right' }}>{r.rejected}</td>
                    <td className="n" style={{ textAlign: 'right' }}>{r.dropped}</td>
                    <td className="n" style={{ textAlign: 'right' }}>{r.joinPct}%</td>
                    <td className="n" style={{ textAlign: 'right' }}>{money(r.payout)}</td>
                    <td className="n" style={{ textAlign: 'right' }}>{r.costPerJoining == null ? '—' : money(r.costPerJoining)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="small-muted" style={{ marginTop: 8, fontSize: 12 }}>{data.dateBasis}</div>
        </>
      )}
    </div>
  );
}
