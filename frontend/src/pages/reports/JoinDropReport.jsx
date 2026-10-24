import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../../api';
import Combo from '../../components/Combo.jsx';
import { ReportBox } from '../../components/joindrop/JoinDropList.jsx';
import ClientHistoryView from '../../components/joindrop/ClientHistoryView.jsx';
import { errText } from '../../components/joindrop/JdParts.jsx';
import '../../components/joindrop/joindrop.css';

// ---------------------------------------------------------------------------
// ATS Reports -> "Joinings and drops": per client, recruiter, department or month: joined, dropped, drop rate, inside the replacement period,
// replacements asked / delivered / not needed, top reasons (+ CSV); and "Client history": one client, date by date.
// ---------------------------------------------------------------------------
export default function JoinDropReport() {
  const [part, setPart] = useState('report');
  const [f, setF] = useState({ from: '', to: '', department: '', clientId: '', recruiter: '', groupBy: 'client' });
  const [r, setR] = useState(null);
  const [fac, setFac] = useState({});
  const [err, setErr] = useState('');
  const [clients, setClients] = useState([]);
  const [hist, setHist] = useState('');
  const [canExport, setCanExport] = useState(false);

  const params = useMemo(() => { const p = {}; Object.entries(f).forEach(([k, v]) => { if (v) p[k] = v; }); return p; }, [f]);
  const load = useCallback(() => {
    api.get('/join-drop/report', { params }).then((x) => { setR(x.data); setCanExport(!!x.data.rights?.export); setErr(''); }).catch((e) => setErr(errText(e, 'Could not load the report.')));
    api.get('/join-drop/list', { params: { ...params, pageSize: 5, groupBy: undefined } }).then((x) => setFac(x.data.facets || {})).catch(() => {});
  }, [params]);
  useEffect(load, [load]);
  useEffect(() => { api.get('/requirements/client-options').then((x) => setClients(x.data || [])).catch(() => setClients([])); }, []);
  const set = (k, v) => setF((x) => { const n = { ...x, [k]: v }; if (k === 'department') { n.clientId = ''; n.recruiter = ''; } return n; });

  async function csv() {
    try {
      const x = await api.get('/join-drop/report/export', { params, responseType: 'blob' });
      const href = URL.createObjectURL(x.data);
      const a = document.createElement('a'); a.href = href; a.download = 'joinings-and-drops-report.csv'; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 30000);
    } catch { setErr('Could not download the file.'); }
  }

  return (
    <div>
      <div className="jd-filters" role="tablist" aria-label="Joinings and drops reports">
        <button type="button" role="tab" aria-selected={part === 'report'} className={`btn btn-sm${part === 'report' ? ' btn-primary' : ''}`} onClick={() => setPart('report')}>Joinings and drops</button>
        <button type="button" role="tab" aria-selected={part === 'history'} className={`btn btn-sm${part === 'history' ? ' btn-primary' : ''}`} onClick={() => setPart('history')}>Client history (date by date)</button>
      </div>
      {err && <div className="notice red"><span>{err}</span></div>}
      {part === 'report' && (
        <>
          <div className="jd-filters">
            <label><span>Joined from</span><input type="date" value={f.from} onChange={(e) => set('from', e.target.value)} /></label>
            <label><span>Joined to</span><input type="date" value={f.to} onChange={(e) => set('to', e.target.value)} /></label>
            <label><span>Department</span><Combo value={f.department} onChange={(e) => set('department', e.target.value)}><option value="">All departments</option>{(fac.departments || []).map((d) => <option key={d.value} value={d.value}>{`${d.value} (${d.count})`}</option>)}</Combo></label>
            <label><span>Client</span><Combo value={f.clientId} onChange={(e) => set('clientId', e.target.value)}><option value="">All clients</option>{(fac.clients || []).map((d) => <option key={d.value} value={d.value}>{`${d.label} (${d.count})`}</option>)}</Combo></label>
            <label><span>Recruiter</span><Combo value={f.recruiter} onChange={(e) => set('recruiter', e.target.value)}><option value="">All recruiters</option>{(fac.recruiters || []).map((d) => <option key={d.value} value={d.value}>{`${d.label} (${d.count})`}</option>)}</Combo></label>
            <label><span>Show by</span><Combo value={f.groupBy} onChange={(e) => set('groupBy', e.target.value)}><option value="client">Client</option><option value="recruiter">Recruiter</option><option value="department">Department</option><option value="month">Month</option></Combo></label>
          </div>
          {r ? <ReportBox r={r} canExport={canExport} onCsv={csv} /> : <div className="small-muted">Loading…</div>}
        </>
      )}
      {part === 'history' && (
        <>
          <div className="jd-filters">
            <label className="wide"><span>Client</span>
              <Combo value={hist} onChange={(e) => setHist(e.target.value)}><option value="">Type a client name to search</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Combo>
            </label>
          </div>
          {hist ? <ClientHistoryView endpoint={`/join-drop/client-history/${hist}`} /> : <div className="small-muted">Pick a client to see what happened with them, date by date.</div>}
        </>
      )}
    </div>
  );
}
