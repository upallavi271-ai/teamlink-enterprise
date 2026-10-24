import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../../api';
import Combo from '../Combo.jsx';
import Pager from '../Pager.jsx';
import StatusChip from '../ui/StatusChip.jsx';
import { Modal } from '../proto.jsx';
import JoiningDropPanel from './JoiningDropPanel.jsx';
import {
  dmy, errText, statusTone, DropDialog,
} from './JdParts.jsx';
import './joindrop.css';

// ---------------------------------------------------------------------------
// ATS -> Joining -> "Joined and dropped": every joining with its dates, place, client, job, recruiter, status, days since joining, the replacement
// period (until when, how many days, how it was decided), the replacement status and the key journey dates. Filters cascade (a department
// narrows the client and recruiter lists, with counts). CSV and the small report are here too. Server: routes/joinDrop.js.
// ---------------------------------------------------------------------------
const EMPTY = { q: '', from: '', to: '', department: '', clientId: '', recruiter: '', reason: '', within: '', replacement: '', needs: '' };
const REPL_OPTS = ['waiting', 'Requested', 'New candidate added', 'Closed', 'Not needed'];
const REPL_WORDS = { waiting: 'Waiting for the client', Requested: 'Replacement requested', 'New candidate added': 'New candidate added', Closed: 'Closed', 'Not needed': 'Not needed' };

export default function JoinDropList({ onOpen }) {
  const [sp] = useSearchParams();
  const [f, setF] = useState(EMPTY);
  const [view, setView] = useState('all');
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(25);
  const [data, setData] = useState({ rows: [], total: 0, counts: {}, facets: {}, rights: {} });
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [meta, setMeta] = useState(null);
  const [drop, setDrop] = useState(null);
  const [detail, setDetail] = useState(null); // the joining details window (works for every login that may see the list)
  const [msg, setMsg] = useState('');
  const [report, setReport] = useState(null);

  const params = useMemo(() => {
    const p = { page, pageSize: size };
    Object.entries(f).forEach(([k, v]) => { if (v) p[k] = v; });
    if (view !== 'all') p.view = view;
    return p;
  }, [f, view, page, size]);

  const load = useCallback(() => {
    setLoading(true);
    api.get('/join-drop/list', { params }).then((r) => { setData(r.data); setErr(''); }).catch((e) => setErr(errText(e, 'Could not load the list.'))).finally(() => setLoading(false));
  }, [params]);
  useEffect(load, [load]);
  useEffect(() => { api.get('/join-drop/meta').then((r) => setMeta(r.data)).catch(() => {}); }, []);
  useEffect(() => { setPage(1); }, [f, view, size]);

  // a bell link: ?record=<id> opens that candidate's drawer
  useEffect(() => {
    const id = sp.get('record');
    if (!id || !onOpen) return;
    api.get(`/join-drop/${id}`).then((r) => { const x = r.data.record; if (x) onOpen({ id: x.applicationId, candidate: { id: x.candidateId, name: x.candidateName } }); }).catch(() => {});
  }, [sp, onOpen]);

  const set = (k, v) => setF((x) => {
    const n = { ...x, [k]: v };
    if (k === 'department') { n.clientId = ''; n.recruiter = ''; }
    return n;
  });
  const clear = () => setF(EMPTY);
  const active = Object.values(f).some(Boolean);
  const rows = data.rows || [];
  const fac = data.facets || {};

  async function download(path, name) {
    setErr('');
    try {
      const r = await api.get(path, { params, responseType: 'blob' });
      const href = URL.createObjectURL(r.data);
      const a = document.createElement('a'); a.href = href; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 30000);
    } catch (e) { setErr('Could not download the file.'); }
  }
  async function openReport() {
    try { const r = await api.get('/join-drop/report', { params: { ...params, groupBy: 'client', page: undefined, pageSize: undefined, view: undefined } }); setReport(r.data); } catch (e) { setErr(errText(e)); }
  }

  const c = data.counts || {};
  return (
    <div>
      {msg && <div className="jd-banner green" role="status">{msg}</div>}
      {err && <div className="notice red"><span>{err}</span></div>}
      <div className="jd-strip">
        <div className="tile"><b>{c.all || 0}</b><span>Joinings</span></div>
        <div className="tile"><b>{c.Joined || 0}</b><span>Still working</span></div>
        <div className="tile"><b>{c.Dropped || 0}</b><span>Dropped</span></div>
        <div className="tile"><b>{c.needsDecision || 0}</b><span>Waiting for the client&apos;s answer</span></div>
        <div className="tile"><b>{c.needsDetails || 0}</b><span>Details not recorded</span></div>
      </div>
      <div className="jd-filters">
        <label className="wide"><span>Search</span><input type="text" value={f.q} placeholder="Name, requirement, client, place" onChange={(e) => set('q', e.target.value)} /></label>
        <label><span>Joined from</span><input type="date" value={f.from} onChange={(e) => set('from', e.target.value)} /></label>
        <label><span>Joined to</span><input type="date" value={f.to} onChange={(e) => set('to', e.target.value)} /></label>
        <label><span>Department</span>
          <Combo value={f.department} onChange={(e) => set('department', e.target.value)}><option value="">All departments</option>{(fac.departments || []).map((d) => <option key={d.value} value={d.value}>{`${d.value} (${d.count})`}</option>)}</Combo>
        </label>
        <label><span>Client</span>
          <Combo value={f.clientId} onChange={(e) => set('clientId', e.target.value)}><option value="">All clients</option>{(fac.clients || []).map((d) => <option key={d.value} value={d.value}>{`${d.label} (${d.count})`}</option>)}</Combo>
        </label>
        <label><span>Recruiter</span>
          <Combo value={f.recruiter} onChange={(e) => set('recruiter', e.target.value)}><option value="">All recruiters</option>{(fac.recruiters || []).map((d) => <option key={d.value} value={d.value}>{`${d.label} (${d.count})`}</option>)}</Combo>
        </label>
        <label><span>Reason for the drop</span>
          <Combo value={f.reason} onChange={(e) => set('reason', e.target.value)}><option value="">Any reason</option>{(fac.reasons || []).map((d) => <option key={d.value} value={d.value}>{`${d.value} (${d.count})`}</option>)}</Combo>
        </label>
        <label><span>Replacement period</span>
          <Combo value={f.within} onChange={(e) => set('within', e.target.value)}><option value="">Any</option><option value="running">Running now (still working)</option><option value="yes">Dropped inside the period</option><option value="no">Dropped after the period</option></Combo>
        </label>
        <label><span>Replacement</span>
          <Combo value={f.replacement} onChange={(e) => set('replacement', e.target.value)}><option value="">Any</option>{REPL_OPTS.map((o) => <option key={o} value={o}>{REPL_WORDS[o]}</option>)}</Combo>
        </label>
        <label><span>Details</span>
          <Combo value={f.needs} onChange={(e) => set('needs', e.target.value)}><option value="">Any</option><option value="yes">Day or place not recorded</option></Combo>
        </label>
        {active && <button type="button" className="btn btn-sm btn-ghost" onClick={clear}>Clear all</button>}
      </div>
      <div className="jd-filters" style={{ alignItems: 'center' }}>
        {[['all', 'All'], ['Joined', 'Still working'], ['Dropped', 'Dropped']].map(([k, label]) => (
          <button key={k} type="button" className={`btn btn-sm${view === k ? ' btn-primary' : ''}`} onClick={() => setView(k)}>{`${label} (${k === 'all' ? c.all || 0 : c[k] || 0})`}</button>
        ))}
        <span style={{ flex: 1 }} />
        {data.rights?.export && <button type="button" className="btn btn-sm" onClick={() => download('/join-drop/export', 'joinings-and-drops.csv')}>Download CSV</button>}
        <button type="button" className="btn btn-sm" onClick={openReport}>Small report</button>
      </div>

      {report && <ReportBox r={report} canExport={data.rights?.export} onClose={() => setReport(null)} onCsv={() => download('/join-drop/report/export', 'joinings-and-drops-report.csv')} />}

      <div className="tbl-wrap" style={loading && rows.length ? { opacity: 0.55 } : undefined}>
        <table className="jd-table">
          <thead>
            <tr><th>Candidate</th><th>Client and requirement</th><th>Joined on</th><th>Place</th><th>Recruiter</th><th>Status</th><th>Days</th><th>Replacement period</th><th>Replacement</th><th>Journey dates</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="jd-cell-wrap"><button type="button" className="btn-link" onClick={() => onOpen && onOpen({ id: r.applicationId, candidate: { id: r.candidateId, name: r.candidateName } })} style={{ background: 'none', border: 0, color: 'var(--blue, #1d4ed8)', cursor: 'pointer', padding: 0, textAlign: 'left' }}>{r.candidateName}</button></td>
                <td className="jd-cell-wrap">{r.clientName}<div className="small-muted">{r.jobTitle}</div></td>
                <td className="jd-cell-wrap">{r.joinedOn ? dmy(r.joinedOn) : <i style={{ color: '#b45309' }}>Not recorded</i>}</td>
                <td className="jd-cell-wrap">{r.location || <i style={{ color: '#b45309' }}>Not recorded</i>}</td>
                <td className="jd-cell-wrap">{r.recruiterName || '—'}</td>
                <td className="jd-cell-wrap">
                  <StatusChip status={r.status === 'Dropped' ? 'Dropped' : 'Joined'} tone={statusTone(r.status)} />
                  {r.status === 'Dropped' && <div className="small-muted">{`${dmy(r.droppedOn)} · ${r.dropReason || 'Not recorded'}`}</div>}
                  {r.dropAfterIncentive && <div className="small-muted" style={{ color: '#b91c1c' }}>After the incentive: HR to review</div>}
                </td>
                <td>{r.dropDaysSinceJoining != null && r.status === 'Dropped' ? r.dropDaysSinceJoining : (r.daysSinceJoining != null ? r.daysSinceJoining : '—')}</td>
                <td className="jd-cell-wrap">
                  {r.hiringType === 'TeamLink Internal Hire' ? '—' : (<>{r.guaranteeEndsOn ? `Until ${dmy(r.guaranteeEndsOn)}` : 'Not set'}<div className="small-muted">{r.guaranteeDays != null ? `${r.guaranteeDays} days · ${r.guaranteeSourceWords}` : ''}</div>
                    {r.status === 'Dropped' && r.dropWithinGuarantee != null && <div className="small-muted">{r.dropWithinGuarantee === 1 ? 'Dropped inside it' : 'Dropped after it'}</div>}
                    {r.status === 'Joined' && r.inGuarantee != null && <div className="small-muted">{r.inGuarantee ? 'Running now' : 'Over'}</div>}</>)}
                </td>
                <td className="jd-cell-wrap">
                  {r.status === 'Dropped' ? (r.replacementDecisionWords || 'Waiting for the client') : '—'}
                  {r.status === 'Dropped' && r.replacementStatus && <div className="small-muted">{r.replacementStatus}</div>}
                  {r.replacementTask && <div className="small-muted">{`Task: ${r.replacementTask.state}`}</div>}
                </td>
                <td className="jd-cell-wrap small-muted" style={{ fontSize: 11.5 }}>
                  {r.journey ? (<>
                    <div>{`Came: ${r.journey.cameOn ? dmy(r.journey.cameOn) : 'Not recorded'}`}</div>
                    <div>{`BDE: ${r.journey.bdeOn ? dmy(r.journey.bdeOn) : 'Not recorded'}`}</div>
                    <div>{`Client: ${r.journey.sentToClientOn ? dmy(r.journey.sentToClientOn) : 'Not recorded'}`}</div>
                    <div>{`Interview: ${r.journey.firstInterviewOn ? dmy(r.journey.firstInterviewOn) : 'Not recorded'}`}</div>
                    <div>{`Offer: ${r.journey.offerOn ? dmy(r.journey.offerOn) : 'Not recorded'}`}</div>
                  </>) : '—'}
                </td>
                <td>
                  <div className="jd-actions" style={{ marginTop: 0 }}>
                    <button type="button" className="btn btn-sm" onClick={() => setDetail(r)}>Joining details</button>
                    {data.rights?.kind !== 'hr' && <button type="button" className="btn btn-sm btn-ghost" onClick={() => onOpen && onOpen({ id: r.applicationId, candidate: { id: r.candidateId, name: r.candidateName } })}>Candidate page</button>}
                    {r.status === 'Joined' && data.rights?.report && r.hiringType !== 'TeamLink Internal Hire' && <button type="button" className="btn btn-sm" onClick={() => setDrop(r)}>Report a drop</button>}
                  </div>
                </td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan="11" style={{ padding: 18 }} className="small-muted">{loading ? 'Loading…' : (active ? 'Nothing matches these filters.' : 'Nobody has joined yet.')}</td></tr>}
          </tbody>
        </table>
      </div>
      <Pager
        page={{
          total: data.total || 0, pages: Math.max(1, Math.ceil((data.total || 0) / size)), size, setSize, page, setPage, from: (data.total || 0) === 0 ? 0 : (page - 1) * size + 1, to: Math.min(page * size, data.total || 0),
        }}
        noun="joinings"
        sizes={[25, 50, 100]}
      />

      {detail && (
        <Modal wide title={`${detail.candidateName}: joining and drop`} onClose={() => { setDetail(null); load(); }}>
          <JoiningDropPanel app={{ id: detail.applicationId, stage: 'JOINED' }} onChanged={load} />
        </Modal>
      )}
      {drop && <DropDialog rec={drop} meta={meta} endpoint={`/join-drop/${drop.id}/drop`} onClose={() => setDrop(null)} onDone={(r) => { setDrop(null); setMsg(r.message || 'Saved.'); load(); }} />}
    </div>
  );
}

export function ReportBox({ r, onClose, onCsv, canExport }) {
  const t = r.totals || {};
  return (
    <div className="jd-card">
      <div className="jd-head"><h4>Joinings and drops: the small report</h4><div className="jd-actions" style={{ marginTop: 0 }}>{canExport && onCsv && <button type="button" className="btn btn-sm" onClick={onCsv}>Download CSV</button>}{onClose && <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>Close</button>}</div></div>
      <div className="jd-strip">
        <div className="tile"><b>{t.joined}</b><span>Joined</span></div>
        <div className="tile"><b>{t.dropped}</b><span>Dropped</span></div>
        <div className="tile"><b>{t.dropRate}%</b><span>Drop rate</span></div>
        <div className="tile"><b>{t.withinGuarantee}</b><span>Dropped inside the period</span></div>
        <div className="tile"><b>{t.replacementsRequested}</b><span>Replacements asked</span></div>
        <div className="tile"><b>{t.replacementsDelivered}</b><span>Replacements delivered</span></div>
        <div className="tile"><b>{t.replacementsNotNeeded}</b><span>Not needed</span></div>
        <div className="tile"><b>{t.waitingForClient}</b><span>Waiting for the client</span></div>
      </div>
      <div className="tbl-wrap">
        <table className="jd-table">
          <thead><tr><th>{{ client: 'Client', recruiter: 'Recruiter', department: 'Department', month: 'Month' }[r.groupBy] || 'Group'}</th><th>Joined</th><th>Dropped</th><th>Drop rate</th><th>Inside the period</th><th>Asked</th><th>Delivered</th><th>Not needed</th><th>Waiting</th></tr></thead>
          <tbody>
            {(r.by || []).map((g) => (
              <tr key={g.name}><td className="jd-cell-wrap">{g.name}</td><td>{g.joined}</td><td>{g.dropped}</td><td>{g.dropRate}%</td><td>{g.withinGuarantee}</td><td>{g.replacementsRequested}</td><td>{g.replacementsDelivered}</td><td>{g.replacementsNotNeeded}</td><td>{g.waitingForClient}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      {(r.topReasons || []).length > 0 && <div style={{ marginTop: 8 }}><b>Top reasons:</b> {r.topReasons.map((x) => `${x.reason} (${x.count})`).join(', ')}</div>}
      <div className="small-muted" style={{ marginTop: 6 }}>{r.note}</div>
    </div>
  );
}
