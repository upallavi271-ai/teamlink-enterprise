import { useEffect, useState } from 'react';
import api from '../../api';
import sharedGet from '../../utils/sharedGet';
import Modal from '../../components/Modal.jsx';
import HomeDrill from '../../components/dashboard/HomeDrill.jsx';
// The Jobs module's own bulk assign (one department at a time, with Undo).
import RequirementBulk from '../../components/jobs/RequirementBulk.jsx';

// ---------------------------------------------------------------------------
// Administration → Company Setup → DATA CLEANUP (dashboard review #2): the
// one-time backlog, OFF the dashboard.
//   · Stale — nothing has happened for 30+ days (mostly the old import):
//     see the list, close them in bulk (Rejected or On Hold, with a reason).
//   · Old jobs with no recruiter (open 30+ days): see the list, assign them
//     on Jobs (its "Assign recruiter" bulk button).
// The numbers come from the dashboard's own builder (GET /dashboard/ats/home
// → cleanup), so they match what the dashboard leaves out.
// ---------------------------------------------------------------------------
const LIST_URL = '/dashboard/ats/home/list';
const fmt = (n) => Number(n || 0).toLocaleString('en-IN');

function CloseStaleDialog({ st, onClose, onDone }) {
  const [stages, setStages] = useState(() => st.stages.map((s) => s.stage));
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const n = st.stages.filter((s) => stages.includes(s.stage) && s.stage !== target).reduce((x, s) => x + s.count, 0);
  const label = (st.targets.find((t) => t.id === target) || {}).label;
  const ok = target && n > 0 && reason.trim().length >= 5;
  async function submit() {
    setBusy(true); setErr('');
    try {
      const r = await api.post('/dashboard/ats/stale/close', { target, reason, stages, expected: n });
      onDone(`Done — ${fmt(r.data.moved)} moved to ${r.data.target}. Each history says who, when and why.`);
    } catch (e) {
      setErr(e.response?.data?.error || 'Could not close them. Try again.');
    } finally { setBusy(false); }
  }
  return (
    <Modal
      title="Close stale applications"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={!ok || busy} onClick={submit}>
            {busy ? 'Closing…' : ok ? `Move ${fmt(n)} to ${label}` : 'Move'}
          </button>
        </>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p className="small-muted" style={{ margin: 0 }}>Nothing is deleted. No message goes to candidates.</p>
        <div>
          <div className="small-muted" style={{ fontWeight: 600 }}>Which steps</div>
          {st.stages.map((s) => (
            <label key={s.stage} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={stages.includes(s.stage)} onChange={(e) => setStages(e.target.checked ? [...stages, s.stage] : stages.filter((x) => x !== s.stage))} />
              {s.label} <span className="small-muted">({fmt(s.count)})</span>
            </label>
          ))}
        </div>
        <div>
          <div className="small-muted" style={{ fontWeight: 600 }}>Move them to</div>
          {st.targets.map((t) => (
            <label key={t.id} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="radio" name="stale-target" checked={target === t.id} onChange={() => setTarget(t.id)} /> {t.label}
            </label>
          ))}
        </div>
        <label>
          <div className="small-muted" style={{ fontWeight: 600 }}>Reason (kept in each history)</div>
          <textarea rows={3} style={{ width: '100%' }} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Old import — no activity since" />
        </label>
        {err && <div className="notice red">{err}</div>}
      </div>
    </Modal>
  );
}

export default function DataCleanup() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [drill, setDrill] = useState(null);
  const [closing, setClosing] = useState(false);
  const [done, setDone] = useState('');
  const [tick, setTick] = useState(0);
  const [assign, setAssign] = useState(null); // job items for the bulk dialog
  const [loadingJobs, setLoadingJobs] = useState(false);
  async function openAssign() {
    setLoadingJobs(true); setError('');
    try {
      const items = [];
      for (let page = 1; page < 100; page += 1) {
        // eslint-disable-next-line no-await-in-loop
        const r = await api.get(LIST_URL, { params: { set: 'old-unassigned', d_size: 200, d_page: page } });
        r.data.rows.forEach((x) => items.push({ id: x.id, reqCode: x.reqCode, title: x.title }));
        if (items.length >= r.data.filtered || !r.data.rows.length) break;
      }
      setAssign(items);
    } catch (e) {
      setError(e.response?.data?.error || 'Could not load the jobs. Try again.');
    } finally { setLoadingJobs(false); }
  }
  useEffect(() => {
    let alive = true;
    sharedGet('/dashboard/ats/home', tick ? { fresh: '1' } : {})
      .then((r) => { if (alive) setData(r.data); })
      .catch((e) => { if (alive) setError(e.response?.data?.error || 'Could not load. Refresh the page.'); });
    return () => { alive = false; };
  }, [tick]);
  const cu = data && data.cleanup;
  return (
    <div style={{ maxWidth: 860 }}>
      <div className="page-head">
        <div>
          <h1>Data cleanup</h1>
          <div className="page-sub">Old work to close or assign, once.</div>
        </div>
      </div>
      {done && <div className="notice green">{done}</div>}
      {error && <div className="notice red">{error}</div>}
      {!data && !error && <div className="small-muted">Loading…</div>}
      {cu && !cu.canClose && <div className="notice">Only a Super Admin or Admin can clean up data.</div>}
      {cu && (
        <>
          <div className="panel">
            <div className="panel-head">
              <h3>Stale — no activity for {cu.days}+ days</h3>
              {cu.canClose && cu.stale > 0 && <button type="button" className="btn btn-primary btn-sm" onClick={() => setClosing(true)}>Close stale…</button>}
            </div>
            <div style={{ padding: '10px 18px 14px' }}>
              {cu.stale ? (
                <>
                  <button type="button" className="link-btn" style={{ fontSize: 22, fontWeight: 700 }} onClick={() => setDrill('stale')}>{fmt(cu.stale)}</button>
                  <span className="small-muted"> applications. Not counted as Late.</span>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                    {cu.stages.map((s) => <span key={s.stage} className="chip" style={{ fontSize: 12 }}>{s.label} <b>{fmt(s.count)}</b></span>)}
                  </div>
                </>
              ) : <span>Nothing stale. 🎉</span>}
            </div>
          </div>
          <div className="panel">
            <div className="panel-head">
              <h3>Old jobs with no recruiter</h3>
              {cu.oldUnassigned > 0 && cu.canClose && <button type="button" className="btn btn-primary btn-sm" disabled={loadingJobs} onClick={openAssign}>{loadingJobs ? 'Loading…' : 'Assign recruiter…'}</button>}
            </div>
            <div style={{ padding: '10px 18px 14px' }}>
              {cu.oldUnassigned ? (
                <>
                  <button type="button" className="link-btn" style={{ fontSize: 22, fontWeight: 700 }} onClick={() => setDrill('old-unassigned')}>{fmt(cu.oldUnassigned)}</button>
                  <span className="small-muted"> jobs open 30+ days, nobody assigned.</span>
                </>
              ) : <span>Every old job has a recruiter. 🎉</span>}
            </div>
          </div>
        </>
      )}
      {drill && <HomeDrill listUrl={LIST_URL} params={{}} setId={drill} onClose={() => setDrill(null)} />}
      {assign && <RequirementBulk kind="assign-recruiter" items={assign} onClose={() => setAssign(null)} onDone={() => setTick((n) => n + 1)} />}
      {closing && cu && <CloseStaleDialog st={cu} onClose={() => setClosing(false)} onDone={(t) => { setClosing(false); setDone(t); setTick((n) => n + 1); }} />}
    </div>
  );
}
