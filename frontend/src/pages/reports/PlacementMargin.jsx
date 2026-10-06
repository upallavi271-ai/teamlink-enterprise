// B2 — Accounts Reports → "Placement margin". One line per placement (an
// invoice), from the Invoices register itself (GET /invoices/margin):
//   Fee billed (before GST) + debit notes − credit notes − recruiter incentive
//   − partner payouts = Margin
// Filters cascade (each list counts only what the other filters leave);
// group by client / recruiter / month; Excel downloads exactly what is shown.
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import { FacetSelect, useLocalFacets } from '../../components/ui/ListPageHeader.jsx';
import { saveBlob } from '../office/officeUtil';
import { money } from '../invoices/invFormat';
import '../invoices/creditNotes.css';

const FIELDS = [
  { key: 'department', get: (r) => r.department },
  { key: 'client', get: (r) => r.client },
  { key: 'recruiter', get: (r) => r.recruiter || 'No recruiter' },
  { key: 'month', get: (r) => r.month, label: (v, r) => r.monthLabel || v },
];
const GROUPS = [['', 'Each placement'], ['client', 'By client'], ['recruiter', 'By recruiter'], ['month', 'By month']];
const BLANK = {
  department: '', client: '', recruiter: '', month: '',
};
const sumUp = (rows) => {
  const s = (k) => Math.round(rows.reduce((a, r) => a + Number(r[k] || 0), 0) * 100) / 100;
  const fee = s('fee');
  const margin = s('margin');
  return {
    placements: rows.length, fee, credit: s('credit'), debit: s('debit'), net: s('net'), incentive: s('incentive'), payout: s('payout'), margin, marginPct: fee > 0 ? Math.round((margin / fee) * 1000) / 10 : null,
  };
};

export default function PlacementMargin({ canExport }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [f, setF] = useState(BLANK);
  const [q, setQ] = useState('');
  const [group, setGroup] = useState('');
  const [sort, setSort] = useState({ k: 'invoiceDate', dir: -1 });
  const [said, setSaid] = useState('');

  useEffect(() => {
    api.get('/invoices/margin')
      .then((res) => setData(res.data))
      .catch((e) => setError(e.response?.data?.error || 'The margin report could not be loaded.'));
  }, []);

  const all = data?.rows || [];
  const facets = useLocalFacets(all, FIELDS, f);
  const needle = q.trim().toLowerCase();
  const rows = useMemo(() => all.filter((r) => (!f.department || r.department === f.department) && (!f.client || r.client === f.client)
    && (!f.recruiter || (r.recruiter || 'No recruiter') === f.recruiter) && (!f.month || r.month === f.month)
    && (!needle || [r.invoiceNumber, r.client, r.candidate, r.recruiter, r.role].filter(Boolean).join(' ').toLowerCase().includes(needle))), [all, f, needle]);
  const tot = sumUp(rows);

  const keyOf = (r) => (group === 'client' ? r.client : group === 'recruiter' ? (r.recruiter || 'No recruiter') : (r.monthLabel || r.month || '—'));
  const groups = useMemo(() => {
    if (!group) return null;
    const m = new Map();
    rows.forEach((r) => { const k = keyOf(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); });
    return [...m.entries()].map(([k, rs]) => ({ key: k, ...sumUp(rs), month: rs[0].month }));
  }, [rows, group]); // eslint-disable-line react-hooks/exhaustive-deps

  const sorted = useMemo(() => {
    const list = (groups || rows).slice();
    const { k, dir } = sort;
    list.sort((a, b) => {
      const x = a[k]; const y = b[k];
      if (typeof x === 'number' || typeof y === 'number') return ((Number(x) || 0) - (Number(y) || 0)) * dir;
      return String(x || '').localeCompare(String(y || '')) * dir;
    });
    return list;
  }, [groups, rows, sort]);
  const th = (k, label, num) => (
    <th className={num ? 'n' : ''} style={{ cursor: 'pointer' }} onClick={() => setSort({ k, dir: sort.k === k ? -sort.dir : (num ? -1 : 1) })}>
      {label}{sort.k === k ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}
    </th>
  );

  const doExport = async () => {
    try {
      const res = await api.post('/invoices/margin/export.xlsx', {
        ids: rows.map((r) => r.id),
        groupBy: group || null,
        filters: [f.department && `Department: ${f.department}`, f.client && `Client: ${f.client}`, f.recruiter && `Recruiter: ${f.recruiter}`, f.month && `Month: ${f.month}`, needle && `Search: ${q.trim()}`].filter(Boolean).join(' · '),
      }, { responseType: 'blob' });
      saveBlob(res, 'placement-margin.xlsx');
      setSaid(`Downloaded ${rows.length} placement(s).`);
    } catch { setError('The Excel file could not be made. Please try again.'); }
  };

  if (!data) return error ? <div className="notice red"><span>{error}</span></div> : <div className="small-muted">Loading margin…</div>;
  const on = Object.values(f).some(Boolean) || !!needle;
  const notDecided = rows.filter((r) => !r.incentiveDecided).length;

  return (
    <div className="cn-page">
      <div className="small-muted">{data.rule}</div>
      {said && <div className="notice" role="status" style={{ margin: 0 }}><span>{said}</span></div>}
      <div className="cn-bar">
        <FacetSelect label="Department" value={f.department} allLabel="All departments" options={facets.department} onChange={(v) => setF({ ...f, department: v })} />
        <FacetSelect label="Client" value={f.client} allLabel="All clients" options={facets.client} onChange={(v) => setF({ ...f, client: v })} />
        <FacetSelect label="Recruiter" value={f.recruiter} allLabel="All recruiters" options={facets.recruiter} onChange={(v) => setF({ ...f, recruiter: v })} />
        <FacetSelect label="Month" value={f.month} allLabel="All months" options={(facets.month || []).slice().sort((a, b) => String(b.value).localeCompare(String(a.value)))} onChange={(v) => setF({ ...f, month: v })} />
        <input type="search" value={q} placeholder="Search invoice no, client, candidate…" onChange={(e) => setQ(e.target.value)} />
        {on && <button type="button" className="btn btn-sm" onClick={() => { setF(BLANK); setQ(''); }}>Clear</button>}
        <span className="grow" />
        {canExport && <button type="button" className="btn btn-sm" disabled={!rows.length} onClick={doExport}>Excel</button>}
      </div>

      <div className="cn-cards">
        <div className="cn-card blue"><b>{money(tot.fee)}</b><span>Fee billed · {tot.placements} placement{tot.placements === 1 ? '' : 's'}</span></div>
        <div className={`cn-card ${tot.credit > 0.5 ? 'orange' : 'green'}`}><b>{money(tot.credit - tot.debit)}</b><span>{tot.credit > 0.5 || tot.debit > 0.5 ? 'Credit notes less debit notes' : 'No credit notes'}</span></div>
        <div className="cn-card blue"><b>{money(tot.incentive + tot.payout)}</b><span>Recruiter incentive{notDecided ? ` · ${notDecided} not decided yet` : ''}</span></div>
        <div className={`cn-card ${tot.margin >= 0 ? 'green' : 'red'}`}><b>{money(tot.margin)}</b><span>Margin{tot.marginPct != null ? ` · ${tot.marginPct}% of the fee` : ''}</span></div>
      </div>

      <div className="cn-tabs" role="tablist" aria-label="Group the margin">
        {GROUPS.map(([k, label]) => (
          <button key={k || 'each'} type="button" role="tab" aria-selected={group === k} className={`cn-tab${group === k ? ' is-on' : ''}`} onClick={() => { setGroup(k); setSort(k ? { k: 'margin', dir: -1 } : { k: 'invoiceDate', dir: -1 }); }}>{label}</button>
        ))}
      </div>

      <div className="tbl-wrap">
        <table className="cn-table">
          <thead>
            {groups ? (
              <tr>{th('key', GROUPS.find(([k]) => k === group)[1].replace('By ', '').replace(/^./, (c) => c.toUpperCase()))}{th('placements', 'Placements', true)}{th('fee', 'Fee billed', true)}{th('credit', 'Credit notes', true)}{th('debit', 'Debit notes', true)}{th('incentive', 'Incentive', true)}{th('payout', 'Partner payout', true)}{th('margin', 'Margin', true)}{th('marginPct', 'Margin %', true)}</tr>
            ) : (
              <tr>{th('invoiceNumber', 'Invoice')}{th('invoiceDate', 'Date')}{th('client', 'Client')}{th('candidate', 'Candidate')}{th('recruiter', 'Recruiter')}{th('fee', 'Fee billed', true)}{th('credit', 'Credit notes', true)}{th('incentive', 'Incentive', true)}{th('payout', 'Partner payout', true)}{th('margin', 'Margin', true)}{th('marginPct', 'Margin %', true)}</tr>
            )}
          </thead>
          <tbody>
            {groups ? sorted.map((g) => (
              <tr key={g.key}>
                <td>{g.key}</td><td className="n">{g.placements}</td><td className="n">{money(g.fee)}</td><td className="n">{money(g.credit)}</td><td className="n">{money(g.debit)}</td>
                <td className="n">{money(g.incentive)}</td><td className="n">{money(g.payout)}</td><td className="n"><b>{money(g.margin)}</b></td><td className="n">{g.marginPct == null ? '—' : `${g.marginPct}%`}</td>
              </tr>
            )) : sorted.map((r) => (
              <tr key={r.id}>
                <td><Link to={`/invoices/${r.id}#margin`}>{r.invoiceNumber}</Link></td>
                <td>{r.invoiceDate || '—'}</td>
                <td>{r.client}</td>
                <td>{r.candidate || '—'}{r.role ? <div className="small-muted">{r.role}</div> : null}</td>
                <td>{r.recruiter || <span className="small-muted">No recruiter</span>}</td>
                <td className="n">{money(r.fee)}{r.debit > 0.5 ? <div className="small-muted">+ {money(r.debit)} debit</div> : null}</td>
                <td className="n">{r.credit > 0.5 ? money(r.credit) : '—'}{r.notes.length ? <div className="small-muted">{r.notes.join(', ')}</div> : null}</td>
                <td className="n" title={r.incentiveStatus}>{money(r.incentive)}{!r.incentiveDecided ? <div className="small-muted">not decided</div> : null}</td>
                <td className="n">{money(r.payout)}</td>
                <td className="n"><b style={{ color: r.margin < 0 ? '#b42318' : undefined }}>{money(r.margin)}</b></td>
                <td className="n">{r.marginPct == null ? '—' : `${r.marginPct}%`}</td>
              </tr>
            ))}
            {!sorted.length && <tr><td colSpan="11" className="small-muted">{all.length ? 'No placement matches these filters.' : 'No invoiced placement yet.'}</td></tr>}
          </tbody>
          {sorted.length > 0 && (
            <tfoot>
              <tr style={{ fontWeight: 700 }}>
                {groups ? (
                  <><td>TOTAL</td><td className="n">{tot.placements}</td><td className="n">{money(tot.fee)}</td><td className="n">{money(tot.credit)}</td><td className="n">{money(tot.debit)}</td><td className="n">{money(tot.incentive)}</td><td className="n">{money(tot.payout)}</td><td className="n">{money(tot.margin)}</td><td className="n">{tot.marginPct == null ? '—' : `${tot.marginPct}%`}</td></>
                ) : (
                  <><td colSpan="5">TOTAL · {tot.placements} placement(s)</td><td className="n">{money(tot.fee + tot.debit)}</td><td className="n">{money(tot.credit)}</td><td className="n">{money(tot.incentive)}</td><td className="n">{money(tot.payout)}</td><td className="n">{money(tot.margin)}</td><td className="n">{tot.marginPct == null ? '—' : `${tot.marginPct}%`}</td></>
                )}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {error && <div className="notice red"><span>{error}</span></div>}
    </div>
  );
}
