import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import Modal from '../Modal.jsx';
import Combo from '../Combo.jsx';

// ---------------------------------------------------------------------------
// OMNI-CHANNEL > INTERNAL (HR) > SCHEDULED MESSAGES: birthday wishes, work anniversaries, policy reminders and custom messages to staff, by Email.
// A rule is OFF when it is made. Only the HR desk / Internal HR / Admin manage them (server: /api/outreach/scheduled*). Staff only: no apply link,
// never counted in job reports. WhatsApp and SMS: coming later.
// ---------------------------------------------------------------------------
const when = (d) => (d ? new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const errOf = (e, fb) => (e && e.response && e.response.data && e.response.data.error) || fb;
const TONE = { off: '', waiting: '', rehearsal: 'kind', on: 'in' };
const RUN_WORDS = { queued: 'Made ready to send', problem: 'Problem' };

function Editor({ rule, opts, onClose, onSaved }) {
  const [f, setF] = useState(rule ? { name: rule.name, kind: rule.kind, trigger: { ...rule.trigger }, time: rule.time, audience: { ...rule.audience }, templateId: rule.templateId } : { name: '', kind: 'birthday', trigger: { type: 'birthday' }, time: '09:00', audience: { type: 'all' }, templateId: '' });
  const [prev, setPrev] = useState(null);
  const [tpls, setTpls] = useState([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get('/outreach/templates', { params: { type: 'internal' } }).then((r) => setTpls(r.data.templates.filter((t) => t.channel === 'email'))).catch(() => setTpls([])); }, []);
  const tpl = tpls.find((t) => t.id === f.templateId);
  useEffect(() => {
    if (!tpl) { setPrev(null); return undefined; }
    const t = setTimeout(() => { api.post('/outreach/templates/preview', { ...tpl, audience: 'internal' }).then((r) => setPrev(r.data.preview)).catch(() => setPrev(null)); }, 150);
    return () => clearTimeout(t);
  }, [tpl]);
  const setKind = (kind) => setF({ ...f, kind, trigger: kind === 'birthday' ? { type: 'birthday' } : (kind === 'anniversary' ? { type: 'anniversary' } : (['birthday', 'anniversary'].includes(f.trigger.type) ? { type: 'fixed', date: '' } : f.trigger)) });
  const setTrig = (patch) => setF({ ...f, trigger: { ...f.trigger, ...patch } });
  const save = async () => {
    setBusy(true); setErr('');
    try { if (rule) await api.put(`/outreach/scheduled/${rule.id}`, f); else await api.post('/outreach/scheduled', f); onSaved(!rule); onClose(); } catch (e) { setErr(errOf(e, 'It could not be saved.')); } finally { setBusy(false); }
  };
  const auto = ['birthday', 'anniversary'].includes(f.kind);
  const tt = f.trigger.type;
  return (
    <Modal title={rule ? 'Change scheduled message' : 'New scheduled message'} size="xwide" onClose={onClose} foot={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy || f.name.trim().length < 2 || !f.templateId} onClick={save}>{busy ? 'Saving…' : 'Save'}</button></>}>
      <div className="oc-split">
        <div>
          <div className="field"><span>What is it</span>
            <div className="oc-choice">{opts.kinds.map((k) => <button type="button" key={k.id} className={f.kind === k.id ? 'on' : ''} onClick={() => setKind(k.id)}>{k.words}</button>)}</div>
          </div>
          <label className="field"><span>Name</span><input value={f.name} maxLength={80} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Birthday wishes" /></label>
          <div className="grid-2">
            <div className="field"><span>Who gets it</span>
              <Combo value={f.audience.type} onChange={(e) => setF({ ...f, audience: { type: e.target.value } })}><option value="all">All active staff</option><option value="department">A department</option><option value="group">A staff group</option></Combo>
            </div>
            {f.audience.type === 'department' && <div className="field"><span>Department</span>
              <Combo departments value={f.audience.department || ''} onChange={(e) => setF({ ...f, audience: { type: 'department', department: e.target.value } })}><option value="">Pick a department</option>{opts.departments.map((d) => <option key={d} value={d}>{d}</option>)}</Combo></div>}
            {f.audience.type === 'group' && <div className="field"><span>Staff group</span>
              <Combo value={f.audience.segmentId || ''} onChange={(e) => setF({ ...f, audience: { type: 'group', segmentId: e.target.value } })}><option value="">Pick a group</option>{opts.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</Combo></div>}
          </div>
          <div className="field"><span>Message</span>
            <Combo value={f.templateId} onChange={(e) => setF({ ...f, templateId: e.target.value })}><option value="">Pick a staff message</option>{tpls.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Combo>
            {tpls.length === 0 && <div className="oc-note">You have no staff email messages yet. Write one in Internal (HR) &gt; Templates first.</div>}
          </div>
          <div className="grid-2">
            {!auto && <div className="field"><span>How often</span>
              <Combo value={tt} onChange={(e) => setF({ ...f, trigger: { type: e.target.value } })}><option value="fixed">On one date</option><option value="weekly">Every week</option><option value="monthly">Every month</option></Combo></div>}
            {auto && <div className="field"><span>How often</span><input readOnly value={f.kind === 'birthday' ? 'Every year, on each person’s birthday' : 'Every year, on each person’s work anniversary'} /></div>}
            {!auto && tt === 'fixed' && <label className="field"><span>Date</span><input type="date" value={f.trigger.date || ''} onChange={(e) => setTrig({ date: e.target.value })} /></label>}
            {!auto && tt === 'weekly' && <div className="field"><span>Day</span><Combo value={String(f.trigger.weekday == null ? '' : f.trigger.weekday)} onChange={(e) => setTrig({ weekday: Number(e.target.value) })}><option value="">Pick a day</option>{opts.weekdays.map((w, i) => <option key={w} value={i}>{w}</option>)}</Combo></div>}
            {!auto && tt === 'monthly' && <label className="field"><span>Day of the month</span><input value={f.trigger.day || ''} inputMode="numeric" maxLength={2} onChange={(e) => setTrig({ day: Number(e.target.value.replace(/\D/g, '')) || '' })} /></label>}
            <label className="field"><span>Send time (India time)</span><input type="time" value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} /></label>
          </div>
          <div className="field"><span>Way</span>
            <div className="oc-choice"><button type="button" className="on">Email</button><button type="button" disabled title="Coming later">WhatsApp: coming later</button><button type="button" disabled title="Coming later">SMS: coming later</button></div>
          </div>
          {auto && <div className="oc-note">{f.kind === 'birthday' ? 'Birthdays come from each person’s Employee record (date of birth).' : 'Anniversaries come from each person’s joining date.'} A person is matched by their email address.</div>}
          <div className="oc-note">A new rule is OFF. Nothing is sent until you turn it On. If quiet hours are on for staff messages, it waits for them to end.</div>
        </div>
        <div>
          <b>How it will look</b>
          <div className="oc-prev" style={{ marginTop: 6 }}>{prev ? <><div style={{ fontWeight: 700, marginBottom: 6 }}>{prev.subject}</div>{prev.body}</> : 'Pick a message to see it here.'}</div>
          <div className="oc-note">Shown with a sample name. Each person gets their own name.</div>
        </div>
      </div>
      {err && <div className="bc-err" role="alert">{err}</div>}
    </Modal>
  );
}

function History({ rule, onClose }) {
  const [runs, setRuns] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { api.get(`/outreach/scheduled/${rule.id}/runs`).then((r) => setRuns(r.data.runs)).catch((e) => setErr(errOf(e, 'The history could not be loaded.'))); }, [rule.id]);
  return (
    <Modal title={`History: ${rule.name}`} onClose={onClose} foot={<button type="button" className="btn" onClick={onClose}>Close</button>}>
      {err && <div className="bc-err" role="alert">{err}</div>}
      {!runs && !err && <div className="oc-note">Loading…</div>}
      {runs && runs.length === 0 && <div className="oc-empty"><b>It has not run yet.</b><div>When it sends, each day it ran shows here.</div></div>}
      {runs && runs.length > 0 && <div className="oc-scroll"><table className="oc-table"><thead><tr><th>When</th><th>Day</th><th>People</th><th>Made ready</th><th>Left out</th><th>Note</th></tr></thead><tbody>
        {runs.map((r, i) => <tr key={`${r.at}${i}`}><td>{when(r.at)}</td><td>{r.date}</td><td>{r.people}</td><td>{r.queued}</td><td>{r.skipped}</td><td className="oc-note">{RUN_WORDS[r.status] || r.status}{r.note ? `: ${r.note}` : ''}</td></tr>)}
      </tbody></table></div>}
    </Modal>
  );
}

export default function ScheduledMessages() {
  const [d, setD] = useState(null);
  const [opts, setOpts] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [edit, setEdit] = useState(null);
  const [hist, setHist] = useState(null);
  const [busy, setBusy] = useState('');
  const load = useCallback(() => {
    api.get('/outreach/scheduled').then((r) => setD(r.data)).catch((e) => { setErr(errOf(e, 'Scheduled messages could not be opened.')); setD({ rules: [], ready: false }); });
    api.get('/outreach/scheduled/options').then((r) => setOpts(r.data)).catch(() => setOpts({ templates: [], groups: [], departments: [], kinds: [], weekdays: [] }));
  }, []);
  useEffect(() => { load(); }, [load]);
  const act = async (id, path, okText) => { setErr(''); setMsg(''); setBusy(id + path); try { const r = await api.post(`/outreach/scheduled/${id}/${path}`); setMsg(r.data.words || okText); await load(); } catch (e) { setErr(errOf(e, 'It did not work.')); } finally { setBusy(''); } };
  const del = async (r) => { if (!window.confirm(`Delete "${r.name}"? Messages already sent stay in the Messages list.`)) return; try { await api.delete(`/outreach/scheduled/${r.id}`); setMsg('Deleted.'); load(); } catch (e) { setErr(errOf(e, 'It could not be deleted.')); } };
  if (!d || !opts) return <div className="oc-note">Loading…</div>;
  return (
    <div>
      <div className="oc-bar"><button type="button" className="btn btn-primary" onClick={() => setEdit({})}>New scheduled message</button><span className="oc-note">Birthday wishes, work anniversaries and reminders to your staff, sent by themselves at the time you choose.</span></div>
      {!d.ready && <div className="bc-warn" role="status">Messages are being set up. You can write the rules now; they can be switched On when it is ready.</div>}
      {d.ready && !d.sendingOn && <div className="bc-warn" role="status">Outreach sending is switched OFF, so nothing goes out yet. An Admin switches it on in Job Promotions &gt; Campaigns &gt; Sending settings.</div>}
      {d.ready && d.sendingOn && d.testMode && <div className="bc-warn" role="status">Email is in test mode: rules are rehearsed and nobody is emailed.</div>}
      {d.quiet && <div className="oc-note">{d.quiet}</div>}
      {msg && <div className="bc-ok" role="status">{msg}</div>}
      {err && <div className="bc-err" role="alert">{err}</div>}
      {d.rules.length === 0 && !err && <div className="oc-empty"><b>No scheduled messages yet.</b><div>Press "New scheduled message" to make one, for example a birthday wish.</div></div>}
      <div className="oc-cards">
        {d.rules.map((r) => (
          <div className="oc-card" key={r.id}>
            <h4>{r.name}</h4>
            <div><span className="oc-pill kind">{r.kindWords}</span><span className={`oc-pill ${TONE[r.status.key] || ''}`}>{r.enabled ? 'On' : 'Off'}</span><span className="oc-pill">Email</span></div>
            <div className="oc-note">{r.status.words}</div>
            <div className="oc-note"><b>When:</b> {r.whenWords}</div>
            <div className="oc-note"><b>Who:</b> {r.audienceWords}</div>
            <div className="oc-note"><b>Message:</b> {r.templateName}</div>
            <div className="oc-note"><b>Next:</b> {r.nextRuns.length ? r.nextRuns.map(when).join(' · ') : 'Nothing coming up'}</div>
            {r.todayPeople != null && <div className="oc-note">{r.todayPeople === 0 ? 'Nobody today.' : `${r.todayPeople} ${r.todayPeople === 1 ? 'person' : 'people'} today.`}</div>}
            <div className="oc-row2">
              {r.enabled ? <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => act(r.id, 'off', 'Turned Off. Nothing will be sent.')}>Turn Off</button> : <button type="button" className="btn btn-sm btn-primary" disabled={!!busy} onClick={() => act(r.id, 'on', 'Turned On.')}>Turn On</button>}
              <button type="button" className="btn btn-sm" onClick={() => setEdit(r)}>Edit</button>
              <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => act(r.id, 'test-to-me', 'Sent.')}>{busy === `${r.id}test-to-me` ? 'Sending…' : 'Send a test to me'}</button>
              <button type="button" className="btn btn-sm" onClick={() => setHist(r)}>History</button>
              <button type="button" className="btn btn-sm" onClick={() => del(r)}>Delete</button>
            </div>
          </div>
        ))}
      </div>
      {edit && <Editor rule={edit.id ? edit : null} opts={opts} onClose={() => setEdit(null)} onSaved={(isNew) => { setMsg(isNew ? 'Saved. It is OFF: nothing is sent until you turn it On.' : 'Saved.'); load(); }} />}
      {hist && <History rule={hist} onClose={() => setHist(null)} />}
    </div>
  );
}
