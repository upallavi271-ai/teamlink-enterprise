// ---------------------------------------------------------------------------
// THE VERIFY QUEUE on the Candidates screen (founder audit 2026-11-18): people whose resume data needs a person's eye - low confidence, values that do not look
// right, two different values, a name that differs from the profile. A recruiter corrects a value or marks it checked; the team lead approves.
//   <VerifyButton user />    the "Verify (N)" button for the header of the Candidates screen; opens the panel
//   <VerifyPanel onClose />  tabs: To check - Waiting for the team lead - Stale data (team leads and above) - Settings and parsing quality (Admin)
// Data: /api/ats/data-verify/* (backend routes/dataVerify.js). Nothing here decides who may do what; the server does, again.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import Modal from '../Modal.jsx';
import { FlagRow } from './VerifyBits.jsx';
import './VerifyBits.css';

const errText = (err, fallback) => err?.response?.data?.error || fallback;
const day = (v) => (v ? new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '');
const dayTime = (v) => (v ? new Date(v).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const FIELD_LABEL = {
  name: 'Name', email: 'Email', phone: 'Phone', skills: 'Skills', experience: 'Experience', currentSalary: 'Current salary', expectedSalary: 'Expected salary', noticePeriod: 'Notice period', dob: 'Date of birth', jobs: 'Jobs', degrees: 'Degrees',
};

export function VerifyButton({ onOpen }) {
  const [c, setC] = useState(null);
  useEffect(() => { let on = true; api.get('/ats/data-verify/count').then((r) => { if (on) setC(r.data); }).catch(() => {}); return () => { on = false; }; }, []);
  if (!c || !c.show) return null;
  return (
    <button type="button" className={`btn${c.open ? ' btn-primary' : ''}`} onClick={onOpen} title="Resume data that needs a person's check: low confidence, values that do not look right, two different values">
      {`Verify${c.open ? ` (${c.open})` : ''}`}
    </button>
  );
}

function Queue({ status, reloadCount }) {
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const load = useCallback(() => { api.get('/ats/data-verify/queue', { params: { status } }).then((r) => setD(r.data)).catch((err) => setD({ error: errText(err, 'Could not load the list.'), rows: [] })); }, [status]);
  useEffect(() => { setD(null); load(); }, [load]);
  async function resolve(flag, body) {
    setBusy(true); setMsg(null);
    try {
      const r = await api.post(`/ats/data-verify/flags/${flag.id}/resolve`, body);
      setMsg({ text: r.data.waitingForTl ? 'Marked checked. The team lead approves it.' : 'Done.' });
      load(); if (reloadCount) reloadCount();
    } catch (err) { setMsg({ bad: true, text: errText(err, 'Could not save.') }); } finally { setBusy(false); }
  }
  if (!d) return <div className="small-muted">Loading…</div>;
  if (d.error) return <div className="notice">{d.error}</div>;
  if (!d.rows.length) return <div className="small-muted">{status === 'wait_tl' ? 'Nothing is waiting for the team lead.' : 'Nothing to check. Every resume the system read agrees with the profile.'}</div>;
  return (
    <div>
      <div className="small-muted">{`${d.total} ${d.total === 1 ? 'person' : 'people'}, ${d.flagCount} thing${d.flagCount === 1 ? '' : 's'} to check. A flagged person can still be worked on; the flag stays until it is decided.`}</div>
      {msg && <div className={`crx-flash ${msg.bad ? 'bad' : ''}`} role="status">{msg.text}</div>}
      {d.rows.map((g) => (
        <div key={g.candidate.id} className="vb-group">
          <h4>
            <Link to={`/candidates/${g.candidate.id}?tab=career`}>{g.candidate.name}</Link>
            <span className="small-muted">{[g.candidate.currentSalary && `CTC ${g.candidate.currentSalary}`, g.candidate.experienceYears != null && `${g.candidate.experienceYears} yrs`, g.candidate.location].filter(Boolean).map((x) => ` · ${x}`).join('')}</span>
          </h4>
          {g.flags.map((f) => <FlagRow key={f.id} flag={f} busy={busy} canApprove={d.canApprove} canCorrect onResolve={resolve} />)}
        </div>
      ))}
    </div>
  );
}

function StaleList() {
  const [d, setD] = useState(null);
  useEffect(() => { api.get('/ats/data-verify/stale').then((r) => setD(r.data)).catch((err) => setD({ error: errText(err, 'Could not load.'), rows: [] })); }, []);
  if (!d) return <div className="small-muted">Loading…</div>;
  if (d.error) return <div className="notice">{d.error}</div>;
  return (
    <div>
      <div className="small-muted">{`${d.total} profile${d.total === 1 ? '' : 's'} with a salary, phone or resume older than ${d.days} days that nobody has confirmed. Open one and press "Confirmed current" on its Career tab.`}</div>
      {d.rows.length > 0 && (
        <div className="tbl-wrap" style={{ marginTop: 6 }}><table>
          <thead><tr><th>Person</th><th>Oldest</th><th>Which</th></tr></thead>
          <tbody>
            {d.rows.map((r) => <tr key={r.id}><td><Link to={`/candidates/${r.id}?tab=career`}>{r.name}</Link></td><td>{`${r.oldestDays} days`}</td><td>{r.stale.map((s) => `${s.what} ${s.days}d`).join(', ')}</td></tr>)}
          </tbody>
        </table></div>
      )}
    </div>
  );
}

function AdminCard() {
  const [s, setS] = useState(null);
  const [runs, setRuns] = useState(null);
  const [days, setDays] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  useEffect(() => {
    api.get('/ats/data-verify/settings').then((r) => { setS(r.data); setDays(String(r.data.staleDays)); }).catch(() => {});
    api.get('/ats/data-verify/parse-quality').then((r) => setRuns(r.data)).catch(() => setRuns({ runs: [], denied: true }));
  }, []);
  async function save(patch) {
    setBusy(true); setMsg(null);
    try { const r = await api.put('/ats/data-verify/settings', patch); setS({ ...s, ...r.data }); setDays(String(r.data.staleDays)); setMsg({ text: 'Saved.' }); } catch (err) { setMsg({ bad: true, text: errText(err, 'Could not save.') }); } finally { setBusy(false); }
  }
  async function run() {
    setBusy(true); setMsg(null);
    try { const r = await api.post('/ats/data-verify/parse-quality/run'); setRuns({ ...runs, runs: r.data.runs }); setMsg({ text: `Measured: ${r.data.overall}% over ${r.data.samples} sample resume(s)${r.data.files ? ` and ${r.data.files} of your own` : ''}.` }); } catch (err) { setMsg({ bad: true, text: errText(err, 'Could not measure.') }); } finally { setBusy(false); }
  }
  if (!s) return <div className="small-muted">Loading…</div>;
  return (
    <div>
      <div className="vb-group">
        <h4>Staff uploads</h4>
        <label className="vb-switch">
          <input type="checkbox" checked={!!s.autoCreateStaffUploads} disabled={busy || !s.canChange} onChange={(e) => save({ autoCreateStaffUploads: e.target.checked })} />
          <span>Auto-create candidates from staff uploads when nothing is flagged</span>
        </label>
        <div className="small-muted">Off: every upload waits for a person to press Confirm (the way it works today). On: a clean resume - nothing flagged, not a duplicate, name, contact and both salaries read - is created at once. A flagged resume always waits for Confirm and the team lead's approval.</div>
        {!s.canChange && <div className="small-muted">Only a Super Admin or Admin can change this.</div>}
      </div>
      <div className="vb-group">
        <h4>Stale profile data</h4>
        <div className="crx-row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <span>A salary, phone or resume older than</span>
          <input type="number" min="7" max="1500" value={days} onChange={(e) => setDays(e.target.value)} disabled={!s.canChange} style={{ width: 80 }} aria-label="Stale after days" />
          <span>days is flagged in the data quality report.</span>
          {s.canChange && <button type="button" className="btn btn-sm" disabled={busy || String(s.staleDays) === String(days)} onClick={() => save({ staleDays: Number(days) })}>Save</button>}
        </div>
      </div>
      {runs && !runs.denied && (
        <div className="vb-group">
          <h4>Parsing quality</h4>
          <div className="small-muted">How right the resume parser is, measured on sample resumes with known answers{runs.sampleDirSet ? ' and on the folder set in RESUME_SAMPLE_DIR (a file may have a "name.expected.json" beside it with the right answers)' : '. To measure real resumes, ask the developer to set RESUME_SAMPLE_DIR to a folder of anonymised resumes'}. Every run is kept.</div>
          <div style={{ margin: '6px 0' }}><button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={run}>{busy ? 'Measuring…' : 'Measure now'}</button></div>
          {runs.runs.length > 0 && (
            <div className="tbl-wrap"><table>
              <thead><tr><th>When</th><th>Overall</th><th>Samples</th><th>Own files</th>{Object.keys(FIELD_LABEL).map((f) => <th key={f}>{FIELD_LABEL[f]}</th>)}</tr></thead>
              <tbody>
                {runs.runs.map((r) => (
                  <tr key={r.id}>
                    <td>{dayTime(r.at)}</td><td><b>{r.overall == null ? '—' : `${r.overall}%`}</b></td><td>{r.samples}</td><td>{r.files || 0}</td>
                    {Object.keys(FIELD_LABEL).map((f) => <td key={f}>{r.perField[f] && r.perField[f].accuracy != null ? `${r.perField[f].accuracy}%` : '—'}</td>)}
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </div>
      )}
      {msg && <div className={`crx-flash ${msg.bad ? 'bad' : ''}`} role="status">{msg.text}</div>}
    </div>
  );
}

export function VerifyPanel({ onClose, onChanged }) {
  const [tab, setTab] = useState('open');
  const [info, setInfo] = useState(null);
  const loadInfo = useCallback(() => { api.get('/ats/data-verify/count').then((r) => setInfo(r.data)).catch(() => {}); if (onChanged) onChanged(); }, [onChanged]);
  const [me, setMe] = useState({ approver: false, admin: false });
  useEffect(() => {
    loadInfo();
    api.get('/ats/data-verify/settings').then((r) => setMe((m) => ({ ...m, admin: !!r.data.canChange }))).catch(() => {});
    api.get('/ats/data-verify/stale').then(() => setMe((m) => ({ ...m, approver: true }))).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const tabs = [
    ['open', `To check${info ? ` (${info.open})` : ''}`],
    ['wait_tl', `Waiting for the team lead${info && info.waitingForTl ? ` (${info.waitingForTl})` : ''}`],
    ...(me.approver ? [['stale', 'Stale data']] : []),
    ['admin', me.admin ? 'Settings and parsing quality' : 'Settings'],
  ];
  return (
    <Modal title="Verify resume data" size="wide" onClose={onClose} footer={<button type="button" className="btn btn-primary" onClick={onClose}>Close</button>}>
      <div className="small-muted">What the resume says is compared with what is saved. A value the parser was not sure about, one that does not look right, or two different values land here.</div>
      <div className="vb-tabs" role="tablist">
        {tabs.map(([k, label]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}</button>)}
      </div>
      {(tab === 'open' || tab === 'wait_tl') && <Queue status={tab} reloadCount={loadInfo} />}
      {tab === 'stale' && <StaleList />}
      {tab === 'admin' && <AdminCard />}
    </Modal>
  );
}

export default VerifyPanel;
