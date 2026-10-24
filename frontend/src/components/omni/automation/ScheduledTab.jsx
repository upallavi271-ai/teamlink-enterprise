import { useCallback, useEffect, useState } from 'react';
import Combo from '../../Combo.jsx';
import omni, { errOf } from '../omniApi.js';
import { Banner, Btn, ConfirmModal, DataTable, Empty, GsModal, Panel, Pill, TinyBtn, fmtDateTime } from '../ui.jsx';

// ---------------------------------------------------------------------------
// AUTOMATIONS > SCHEDULED MESSAGES (Admin and the HR desk only): birthday wishes, work anniversaries, policy reminders and custom messages to STAFF, by
// Email, at a set time. The engine is outreach/scheduled.js: a new rule is OFF, nothing goes out while Test mode is on or Outreach sending is off.
// ---------------------------------------------------------------------------
const RUN_WORDS = { queued: 'Made ready to send', problem: 'Problem' };
const emptyForm = () => ({ name: '', kind: 'birthday', trigger: { type: 'birthday' }, time: '09:00', audience: { type: 'all' }, templateId: '' });

function RuleEditor({ rule, opts, onClose, onSaved }) {
  const [f, setF] = useState(rule ? { name: rule.name, kind: rule.kind, trigger: { ...rule.trigger }, time: rule.time, audience: { ...rule.audience }, templateId: rule.templateId } : emptyForm());
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const auto = ['birthday', 'anniversary'].includes(f.kind);
  const tt = f.trigger.type;
  const setKind = (kind) => setF({ ...f, kind, trigger: kind === 'birthday' ? { type: 'birthday' } : (kind === 'anniversary' ? { type: 'anniversary' } : (['birthday', 'anniversary'].includes(f.trigger.type) ? { type: 'fixed', date: '' } : f.trigger)) });
  const setTrig = (patch) => setF({ ...f, trigger: { ...f.trigger, ...patch } });
  const save = async () => {
    setBusy(true); setErr('');
    try { if (rule) await omni.put(`/gs/automation/scheduled/${rule.id}`, f); else await omni.post('/gs/automation/scheduled', f); onSaved(!rule); onClose(); } catch (e) { setErr(errOf(e, 'It could not be saved.')); } finally { setBusy(false); }
  };
  return (
    <GsModal title={rule ? 'Change scheduled message' : 'New scheduled message'} sub="A new rule is Off. Nothing is sent until you turn it On." width={640} onClose={onClose}
      foot={<><Btn onClick={onClose}>Cancel</Btn><Btn primary disabled={busy || f.name.trim().length < 2 || !f.templateId} onClick={save}>{busy ? 'Saving…' : 'Save'}</Btn></>}>
      <div className="field"><label>WHAT IS IT</label>
        <div className="au-bar">{opts.kinds.map((k) => <button type="button" key={k.id} className={`tiny-btn${f.kind === k.id ? ' active' : ''}`} style={f.kind === k.id ? { background: 'var(--green-3)', borderColor: '#bfe3d0', fontWeight: 800 } : undefined} onClick={() => setKind(k.id)}>{k.words}</button>)}</div>
      </div>
      <div className="field" style={{ marginTop: 13 }}><label>NAME</label><input value={f.name} maxLength={80} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Birthday wishes" /></div>
      <div className="form-grid" style={{ marginTop: 13 }}>
        <div className="field"><label>WHO GETS IT</label>
          <Combo value={f.audience.type} onChange={(e) => setF({ ...f, audience: { type: e.target.value } })}><option value="all">All active staff</option><option value="department">A department</option><option value="group">A staff group</option></Combo>
        </div>
        {f.audience.type === 'department' && <div className="field"><label>DEPARTMENT</label><Combo value={f.audience.department || ''} onChange={(e) => setF({ ...f, audience: { type: 'department', department: e.target.value } })}><option value="">Pick a department</option>{opts.departments.map((d) => <option key={d} value={d}>{d}</option>)}</Combo></div>}
        {f.audience.type === 'group' && <div className="field"><label>STAFF GROUP</label><Combo value={f.audience.segmentId || ''} onChange={(e) => setF({ ...f, audience: { type: 'group', segmentId: e.target.value } })}><option value="">Pick a group</option>{opts.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</Combo></div>}
        <div className="field full"><label>MESSAGE (A STAFF EMAIL TEMPLATE)</label>
          <Combo value={f.templateId} onChange={(e) => setF({ ...f, templateId: e.target.value })}><option value="">Pick a staff message</option>{opts.templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Combo>
          {opts.templates.length === 0 && <small style={{ fontSize: 9, color: 'var(--muted)' }}>You have no staff email messages yet. Write one in Manage Templates first.</small>}
        </div>
        {!auto && <div className="field"><label>HOW OFTEN</label><Combo value={tt} onChange={(e) => setF({ ...f, trigger: { type: e.target.value } })}><option value="fixed">On one date</option><option value="weekly">Every week</option><option value="monthly">Every month</option></Combo></div>}
        {auto && <div className="field"><label>HOW OFTEN</label><input readOnly value={f.kind === 'birthday' ? 'Every year, on each person’s birthday' : 'Every year, on each person’s work anniversary'} /></div>}
        {!auto && tt === 'fixed' && <div className="field"><label>DATE</label><input type="date" value={f.trigger.date || ''} onChange={(e) => setTrig({ date: e.target.value })} /></div>}
        {!auto && tt === 'weekly' && <div className="field"><label>DAY</label><Combo value={String(f.trigger.weekday == null ? '' : f.trigger.weekday)} onChange={(e) => setTrig({ weekday: Number(e.target.value) })}><option value="">Pick a day</option>{opts.weekdays.map((w, i) => <option key={w} value={i}>{w}</option>)}</Combo></div>}
        {!auto && tt === 'monthly' && <div className="field"><label>DAY OF THE MONTH</label><input value={f.trigger.day || ''} inputMode="numeric" maxLength={2} onChange={(e) => setTrig({ day: Number(e.target.value.replace(/\D/g, '')) || '' })} /></div>}
        <div className="field"><label>SEND TIME (INDIA TIME)</label><input type="time" value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} /></div>
      </div>
      <div className="au-sub" style={{ marginTop: 10 }}>Sent by Email only for now (WhatsApp and SMS for staff are coming later). {auto ? 'The date comes from each person’s Employee record; a person is matched by email.' : ''}</div>
      {err && <div className="au-err" role="alert">{err}</div>}
    </GsModal>
  );
}

function History({ rule, onClose }) {
  const [runs, setRuns] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { omni.get(`/gs/automation/scheduled/${rule.id}/runs`).then((r) => setRuns(r.runs)).catch((e) => setErr(errOf(e, 'The history could not be loaded.'))); }, [rule.id]);
  return (
    <GsModal title={`History: ${rule.name}`} width={640} onClose={onClose} foot={<Btn onClick={onClose}>Close</Btn>}>
      {err && <div className="au-err" role="alert">{err}</div>}
      {!runs && !err && <div className="au-sub">Loading…</div>}
      {runs && runs.length === 0 && <Empty title="It has not run yet">When it sends, each day it ran shows here.</Empty>}
      {runs && runs.length > 0 && (
        <div className="card table-card"><div className="table-scroll"><table className="table" style={{ minWidth: 0 }}><thead><tr><th>When</th><th>Day</th><th>People</th><th>Made ready</th><th>Left out</th><th>Note</th></tr></thead>
          <tbody>{runs.map((r, i) => <tr key={`${r.at}${i}`}><td style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(r.at)}</td><td>{r.date}</td><td>{r.people}</td><td>{r.queued}</td><td>{r.skipped}</td><td className="au-wrap">{RUN_WORDS[r.status] || r.status}{r.note ? `: ${r.note}` : ''}</td></tr>)}</tbody></table></div></div>
      )}
    </GsModal>
  );
}

export default function ScheduledTab({ toast }) {
  const [d, setD] = useState(null);
  const [opts, setOpts] = useState(null);
  const [err, setErr] = useState('');
  const [edit, setEdit] = useState(null);
  const [hist, setHist] = useState(null);
  const [del, setDel] = useState(null);
  const [busy, setBusy] = useState('');
  const load = useCallback(() => {
    omni.get('/gs/automation/scheduled').then((r) => { setD(r); setErr(''); }).catch((e) => { setErr(errOf(e, 'Scheduled messages could not be opened.')); setD({ rules: [], ready: false }); });
    omni.get('/gs/automation/scheduled/options').then(setOpts).catch(() => setOpts({ templates: [], groups: [], departments: [], kinds: [], weekdays: [] }));
  }, []);
  useEffect(() => { load(); }, [load]);
  const act = async (id, path, okText) => { setErr(''); setBusy(id + path); try { const r = await omni.post(`/gs/automation/scheduled/${id}/${path}`); toast((r && r.words) || okText); load(); } catch (e) { setErr(errOf(e, 'It did not work.')); } finally { setBusy(''); } };
  if (!d || !opts) return <div className="card panel">Loading…</div>;
  const cols = [
    { id: 'name', label: 'Name', render: (r) => <b className="au-name">{r.name}</b>, sort: (r) => r.name },
    { id: 'what', label: 'What', render: (r) => r.kindWords, sort: (r) => r.kindWords },
    { id: 'when', label: 'When', render: (r) => <span className="au-wrap">{r.whenWords}</span>, search: (r) => r.whenWords },
    { id: 'who', label: 'Who', render: (r) => <span className="au-wrap">{r.audienceWords}</span>, search: (r) => r.audienceWords },
    { id: 'msg', label: 'Message', render: (r) => <span className="au-wrap">{r.templateName}</span>, search: (r) => r.templateName },
    { id: 'next', label: 'Next', render: (r) => (r.nextRuns.length ? fmtDateTime(r.nextRuns[0]) : '—'), hide: true },
    { id: 'status', label: 'Status', render: (r) => <span title={r.status.words}><Pill tone={r.enabled ? (r.status.key === 'on' ? 'live' : 'warn') : 'draft'} dot>{r.enabled ? 'On' : 'Off'}</Pill></span>, sort: (r) => (r.enabled ? 1 : 0) },
    { id: 'act', label: '', render: (r) => (
      <div className="au-bar">
        {r.enabled ? <TinyBtn disabled={!!busy} onClick={() => act(r.id, 'off', 'Turned Off. Nothing will be sent.')}>Turn Off</TinyBtn> : <TinyBtn disabled={!!busy} onClick={() => act(r.id, 'on', 'Turned On.')}>Turn On</TinyBtn>}
        <TinyBtn onClick={() => setEdit(r)}>Edit</TinyBtn>
        <TinyBtn disabled={!!busy} onClick={() => act(r.id, 'test-to-me', 'A test was sent to you.')}>{busy === `${r.id}test-to-me` ? 'Sending…' : 'Send a test to me'}</TinyBtn>
        <TinyBtn onClick={() => setHist(r)}>History</TinyBtn>
        <TinyBtn onClick={() => setDel(r)}>Delete</TinyBtn>
      </div>
    ) },
  ];
  return (
    <div>
      {!d.ready && <Banner tone="warn">Messages are being set up. You can write the rules now; they can be switched On when it is ready.</Banner>}
      {d.ready && !d.sendingOn && <Banner tone="warn">Outreach sending is switched OFF, so nothing goes out yet. An Admin switches it on in Settings.</Banner>}
      {d.ready && d.sendingOn && d.testMode && <Banner tone="test">Email is in Test mode: rules are rehearsed and nobody is emailed.</Banner>}
      {d.quiet && <div className="au-sub" style={{ margin: '4px 0 10px' }}>{d.quiet}</div>}
      {err && <div className="au-err" role="alert">{err}</div>}
      <Panel title="Scheduled messages" sub="Birthday wishes, work anniversaries and reminders to your staff, sent by themselves at the time you choose." right={<Btn primary onClick={() => setEdit({})}>＋ New scheduled message</Btn>}>
        <DataTable columns={cols} rows={d.rules} persistKey="auto_sched" searchPlaceholder="Search scheduled messages"
          empty={<Empty title="No scheduled messages yet">Press "New scheduled message" to make one, for example a birthday wish.</Empty>} />
      </Panel>
      {edit && <RuleEditor rule={edit.id ? edit : null} opts={opts} onClose={() => setEdit(null)} onSaved={(isNew) => { toast(isNew ? 'Saved. It is Off: nothing is sent until you turn it On.' : 'Saved'); load(); }} />}
      {hist && <History rule={hist} onClose={() => setHist(null)} />}
      {del && <ConfirmModal danger title="Delete this rule?" text={`Delete "${del.name}"? Messages already sent stay in the message list.`} yes="Delete" onNo={() => setDel(null)}
        onYes={async () => { const r = del; setDel(null); try { await omni.del(`/gs/automation/scheduled/${r.id}`); toast('Deleted'); load(); } catch (e) { setErr(errOf(e, 'It could not be deleted.')); } }} />}
    </div>
  );
}
