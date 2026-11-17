// CRM > DASHBOARD > REPORTS (2026-11-17): by salesperson (leads, contacted, qualified, converted, won value, activities, overdue follow-ups,
// completion), the lead funnel with the conversion between steps, source performance, lost reasons, and the aging of open leads / deals.
// Each table downloads as Excel with the CRM "export" right; every download is in the download log (Sales managers / Admins see it here).
// GET /crm/report-tables, /crm/report-tables/:key/xlsx, /crm/export-log (crm/analytics.js)
import { useEffect, useState } from 'react';
import api from '../../api';
import { useCrm, errOf, money, dateTimeOf, download, istToday, DateField } from './crmShared.jsx';

const MONEY_COLS = new Set(['wonValue', 'dealValue']);
const PCT_COLS = new Set(['completion', 'fromPrevious', 'ofAdded', 'conversion']);
const cell = (k, v) => {
  if (v == null || v === '') return '—';
  if (MONEY_COLS.has(k)) return money(v);
  if (PCT_COLS.has(k)) return `${v}%`;
  return typeof v === 'number' ? v.toLocaleString('en-IN') : v;
};

function ExportLog({ bump }) {
  const { version } = useCrm();
  const [rows, setRows] = useState(null);
  useEffect(() => { api.get('/crm/export-log').then((r) => setRows(r.data.rows)).catch(() => setRows([])); }, [version, bump]);
  return (
    <div className="crm-report">
      <div className="crm-report-head"><h3>Download log</h3><span className="small-muted" style={{ fontSize: 12 }}>every CRM download: who, what, how many rows, when</span></div>
      <div className="tbl-wrap">
        <table>
          <thead><tr><th>When</th><th>Who</th><th>What</th><th>Format</th><th style={{ textAlign: 'right' }}>Rows</th></tr></thead>
          <tbody>
            {rows == null && <tr><td colSpan={5} className="small-muted">Loading…</td></tr>}
            {rows && !rows.length && <tr><td colSpan={5} className="small-muted">Nothing has been downloaded yet.</td></tr>}
            {(rows || []).map((x) => <tr key={x.id}><td style={{ whiteSpace: 'nowrap' }}>{dateTimeOf(x.at)}</td><td>{x.byName || '—'}</td><td>{x.what}</td><td>{String(x.format || '').toUpperCase()}</td><td style={{ textAlign: 'right' }}>{x.rows}</td></tr>)}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function ReportTables({ mine, period, owner }) {
  const { me, toast, version } = useCrm();
  const [bump, setBump] = useState(0);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const custom = from && to && from <= to;
  const params = { ...(custom ? { from, to } : { period }), mine: mine ? 1 : undefined, owner: owner || undefined };
  useEffect(() => {
    let alive = true;
    setD(null);
    api.get('/crm/report-tables', { params }).then((r) => { if (alive) { setD(r.data); setErr(''); } }).catch((e) => { if (alive) setErr(errOf(e, 'The reports could not be read.')); });
    return () => { alive = false; };
  }, [mine, period, owner, from, to, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const canExport = !!(me.rights && me.rights.export);
  async function excel(t) {
    try {
      await download(`/crm/report-tables/${t.key}/xlsx?${new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString()}`, `crm-report-${t.key}-${istToday()}.xlsx`);
      toast(`${t.title}: downloaded.`);
      setBump((n) => n + 1);
    } catch (e) { toast('The download did not work.'); }
  }
  return (
    <div>
      <div className="filter-row" style={{ alignItems: 'center' }}>
        <span className="small-muted" style={{ fontSize: 12.5 }}>{custom ? 'Custom dates:' : `${d ? d.periodLabel : ''} (the period above), or pick dates:`}</span>
        <DateField value={from} onChange={setFrom} aria-label="Report from" style={{ width: 145 }} />
        <DateField value={to} onChange={setTo} aria-label="Report to" style={{ width: 145 }} />
        {(from || to) && <button type="button" className="btn btn-sm" onClick={() => { setFrom(''); setTo(''); }}>Clear dates</button>}
      </div>
      {err && <div className="notice" role="alert">{err}</div>}
      {!d && !err && <div className="small-muted">Loading…</div>}
      {d && d.tables.map((t) => (
        <div key={t.key} className="crm-report">
          <div className="crm-report-head">
            <h3>{t.title}</h3>
            {canExport && <button type="button" className="btn btn-sm" onClick={() => excel(t)} disabled={!t.rows.length}>Excel</button>}
          </div>
          <div className="tbl-wrap">
            <table>
              <thead><tr>{t.columns.map(([k, l], i) => <th key={k} style={i ? { textAlign: 'right' } : undefined}>{l}</th>)}</tr></thead>
              <tbody>
                {!t.rows.length && <tr><td colSpan={t.columns.length} className="small-muted">Nothing in this period.</td></tr>}
                {t.rows.map((row, ri) => <tr key={ri}>{t.columns.map(([k], i) => <td key={k} style={i ? { textAlign: 'right', whiteSpace: 'nowrap' } : undefined}>{i === 0 ? <b>{cell(k, row[k])}</b> : cell(k, row[k])}</td>)}</tr>)}
              </tbody>
            </table>
          </div>
          {t.key === 'owners' && <div className="small-muted" style={{ fontSize: 11.5, marginTop: 4 }}>Leads, contacted, qualified and converted count the leads added in the period; won value and activities what happened in it; overdue is what is late right now; done % is of the follow-ups due in the period up to today.</div>}
          {t.key === 'aging' && <div className="small-muted" style={{ fontSize: 11.5, marginTop: 4 }}>What is still open today, by how long ago it was added.</div>}
        </div>
      ))}
      {me.canAssign && <ExportLog bump={bump} />}
    </div>
  );
}
