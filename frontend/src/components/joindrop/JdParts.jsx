import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import { Modal } from '../proto.jsx';
import Combo from '../Combo.jsx';
import StatusChip from '../ui/StatusChip.jsx';
import './joindrop.css';

// ---------------------------------------------------------------------------
// JOINING & DROP - the small pieces every screen shares (the candidate panel, the Joining list, the client portal, the Admin switches).
// Plain words only. No red asterisks: a missing piece is told in a sentence when you press Save. Every dropdown can be typed in; the reason
// list also takes your own words.
// ---------------------------------------------------------------------------
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const todayIst = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
export function dmy(iso) {
  const s = String(iso || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return 'Not recorded';
  return `${Number(s.slice(8, 10))} ${MON[Number(s.slice(5, 7)) - 1]} ${s.slice(0, 4)}`;
}
export function when(iso) {
  if (!iso) return 'Not recorded';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Not recorded';
  return d.toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
export const errText = (e, fallback = 'That could not be saved. Please try again.') => e?.response?.data?.error || fallback;

export function KV({ k, v, nr }) {
  const empty = v === null || v === undefined || v === '';
  return (
    <div className="jd-kv">
      <div className="k">{k}</div>
      <div className={`v${empty || nr ? ' nr' : ''}`}>{empty ? 'Not recorded' : v}</div>
    </div>
  );
}

export const statusTone = (s) => (s === 'Dropped' ? 'red' : 'green');

// The people who will be told (the confirm line). staff: asked from the server; the client sees a fixed sentence.
export function usePeople(recordId, moment, enabled = true) {
  const [p, setP] = useState(null);
  useEffect(() => {
    if (!enabled || !recordId) return;
    api.get(`/join-drop/${recordId}/people`, { params: { moment } }).then((r) => setP(r.data)).catch(() => setP(null));
  }, [recordId, moment, enabled]);
  return p;
}
function ToldLine({ people }) {
  if (!people) return null;
  const list = (people.parties || []).map((x) => `${x.word} (${x.ways.join(' + ')})`);
  return (
    <div className="jd-banner blue">
      {list.length ? `These people will be told: ${list.join('; ')}.` : 'Nobody is set to be told. An Admin can change this in Administration, Step timing.'}
      {people.emailsOn === false && ' Emails are switched off at the moment, so only bells and tasks go out.'}
    </div>
  );
}

// --- a reason (cancel the task, withdraw a drop, close a replacement) ------------------------------------------------------------------
export function ReasonDialog({ title, lead, label = 'Why?', button = 'Save', endpoint, field = 'reason', onClose, onDone }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function save() {
    setBusy(true); setErr('');
    try { const r = await api.post(endpoint, { [field]: text.trim() }); onDone(r.data); } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  }
  return (
    <Modal title={title} onClose={onClose} footer={<button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : button}</button>}>
      {lead && <div className="small-muted" style={{ marginBottom: 8 }}>{lead}</div>}
      <label className="field"><span>{label}</span><textarea rows="3" maxLength={300} value={text} onChange={(e) => setText(e.target.value)} /></label>
      {err && <div className="error-text">{err}</div>}
    </Modal>
  );
}

// --- add details / correct the joining ---------------------------------------------------------------------------------------------------
const TYPES = ['Full Time', 'Part Time', 'Contract', 'Internship', 'Permanent'];
export function JoiningDialog({ rec, endpointAdd, endpointCorrect, canPay, onClose, onDone }) {
  const [f, setF] = useState({
    joinedOn: rec.joinedOn || '', location: rec.location || '', designation: rec.designation || '', employmentType: rec.employmentType || '',
    reportingPerson: rec.reportingPerson || '', reportingContact: rec.reportingContact || '', notes: rec.notes || '', offeredCtc: rec.offeredCtc || '', reason: '',
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const adding = !rec.joinedOn || !rec.location;
  async function save() {
    setBusy(true); setErr('');
    try {
      const body = { ...f };
      if (!canPay) delete body.offeredCtc;
      if (body.offeredCtc === '') delete body.offeredCtc;
      const r = adding && endpointAdd ? await api.post(endpointAdd, body) : await api.patch(endpointCorrect, body);
      onDone(r.data);
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  }
  return (
    <Modal wide title={adding ? `Add joining details: ${rec.candidateName}` : `Correct the joining details: ${rec.candidateName}`} onClose={onClose} footer={<button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>}>
      <div className="jd-grid">
        <label className="field"><span>Day they joined</span><input type="date" max={todayIst()} value={f.joinedOn} onChange={(e) => set('joinedOn', e.target.value)} /></label>
        <label className="field"><span>Place (city or branch)</span><input type="text" maxLength={120} value={f.location} onChange={(e) => set('location', e.target.value)} placeholder="Where they joined" /></label>
        <label className="field"><span>Designation</span><input type="text" maxLength={120} value={f.designation} onChange={(e) => set('designation', e.target.value)} /></label>
        <label className="field"><span>Employment type</span>
          <Combo creatable value={f.employmentType} onChange={(e) => set('employmentType', e.target.value)}><option value="">Choose or type</option>{TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</Combo>
        </label>
        <label className="field"><span>Reporting person at the client</span><input type="text" maxLength={120} value={f.reportingPerson} onChange={(e) => set('reportingPerson', e.target.value)} /></label>
        <label className="field"><span>Their phone or email</span><input type="text" maxLength={160} value={f.reportingContact} onChange={(e) => set('reportingContact', e.target.value)} /></label>
        {canPay && <label className="field"><span>Pay (CTC a year)</span><input type="number" min="0" value={f.offeredCtc} onChange={(e) => set('offeredCtc', e.target.value)} /></label>}
      </div>
      <label className="field"><span>Notes</span><textarea rows="2" maxLength={1500} value={f.notes} onChange={(e) => set('notes', e.target.value)} /></label>
      {!adding && <label className="field"><span>Why are you changing it? (only needed when something already recorded changes)</span><input type="text" maxLength={300} value={f.reason} onChange={(e) => set('reason', e.target.value)} /></label>}
      <div className="small-muted">The replacement period follows the joining day. Every change is kept in the history.</div>
      {err && <div className="error-text">{err}</div>}
    </Modal>
  );
}

// --- report a drop / correct a drop -----------------------------------------------------------------------------------------------------
export function DropDialog({
  rec, meta, endpoint, method = 'post', correcting = false, audience = 'staff', onClose, onDone,
}) {
  const [f, setF] = useState({
    droppedOn: rec.droppedOn || todayIst(), lastWorkingDay: rec.lastWorkingDay || '', reason: rec.dropReason || '', reasonDetail: rec.dropReasonDetail || '', correctionReason: '',
  });
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const people = usePeople(rec.id, 'drop', audience === 'staff' && !correcting && step === 2);
  const reasons = meta?.reasons || [];
  const other = meta?.otherReason || 'Other (type it)';
  function next() {
    setErr('');
    if (!f.droppedOn) return setErr('Enter the day the candidate dropped.');
    if (rec.joinedOn && f.droppedOn < rec.joinedOn) return setErr(`The drop day cannot be before the joining day (${dmy(rec.joinedOn)}).`);
    if (f.droppedOn > todayIst()) return setErr('The drop day cannot be a day that has not come yet.');
    if (!f.reason.trim()) return setErr('Choose why the candidate dropped, or type your own reason.');
    if (f.reason === other && !f.reasonDetail.trim()) return setErr('You chose "Other". Please type the reason in the details box.');
    if (correcting && f.correctionReason.trim().length < 3) return setErr('Say in a few words why you are correcting it.');
    return setStep(2);
  }
  async function save() {
    setBusy(true); setErr('');
    try {
      const body = { ...f };
      if (!body.lastWorkingDay) delete body.lastWorkingDay;
      const r = method === 'patch' ? await api.patch(endpoint, body) : await api.post(endpoint, body);
      onDone(r.data);
    } catch (e) { setErr(errText(e)); setStep(1); } finally { setBusy(false); }
  }
  const inside = rec.guaranteeEndsOn && f.droppedOn && f.droppedOn <= rec.guaranteeEndsOn;
  return (
    <Modal
      title={`${correcting ? 'Correct the drop' : 'Report a drop'}: ${rec.candidateName}`}
      onClose={onClose}
      footer={step === 1
        ? <button type="button" className="btn btn-primary" onClick={next}>Next</button>
        : (<><button type="button" className="btn" onClick={() => setStep(1)}>Back</button><button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Yes, save it'}</button></>)}
    >
      {rec.guaranteeLine && <div className="jd-banner blue">{rec.guaranteeLine}</div>}
      {step === 1 ? (
        <>
          <div className="jd-grid">
            <label className="field"><span>Day they dropped</span><input type="date" min={rec.joinedOn || undefined} max={todayIst()} value={f.droppedOn} onChange={(e) => set('droppedOn', e.target.value)} /></label>
            <label className="field"><span>Last working day (if you know it)</span><input type="date" min={rec.joinedOn || undefined} max={todayIst()} value={f.lastWorkingDay} onChange={(e) => set('lastWorkingDay', e.target.value)} /></label>
          </div>
          <label className="field"><span>Why did they drop?</span>
            <Combo creatable value={f.reason} onChange={(e) => set('reason', e.target.value)}><option value="">Choose, or type your own reason</option>{reasons.map((x) => <option key={x} value={x}>{x}</option>)}</Combo>
          </label>
          <label className="field"><span>More about the reason</span><textarea rows="3" maxLength={1000} value={f.reasonDetail} onChange={(e) => set('reasonDetail', e.target.value)} placeholder="What happened, in a few words" /></label>
          {correcting && <label className="field"><span>Why are you correcting it?</span><input type="text" maxLength={300} value={f.correctionReason} onChange={(e) => set('correctionReason', e.target.value)} /></label>}
        </>
      ) : (
        <>
          <div className="jd-banner">
            Please check: <b>{rec.candidateName}</b> dropped on <b>{dmy(f.droppedOn)}</b>{f.lastWorkingDay ? <>, last working day <b>{dmy(f.lastWorkingDay)}</b></> : ''}. Reason: <b>{f.reason}</b>{f.reasonDetail ? ` (${f.reasonDetail})` : ''}.
            {rec.guaranteeEndsOn ? (inside ? ' This is INSIDE the replacement period.' : ' This is AFTER the replacement period.') : ''}
          </div>
          {audience === 'client' && <div className="jd-banner blue">Your recruiter, BDE, team lead and HR will be told.</div>}
          {audience === 'staff' && !correcting && <ToldLine people={people} />}
          {audience === 'staff' && !correcting && inside && <div className="jd-banner green">A &quot;Find a replacement&quot; task opens for the recruiter at once. The client&apos;s yes or no stays pending.</div>}
        </>
      )}
      {err && <div className="error-text">{err}</div>}
    </Modal>
  );
}

// --- the client's three choices (also used by staff on the client's behalf) ---------------------------------------------------------------
export function DecisionForm({ rec, onSave, busy, big = false, buttonText = 'Save' }) {
  const [d, setD] = useState(rec.replacementDecision || '');
  const [comment, setComment] = useState(rec.replacementComment || '');
  const [expectedOn, setExpectedOn] = useState(rec.replacementExpectedOn || '');
  const [profile, setProfile] = useState(rec.replacementProfileNotes || '');
  const [err, setErr] = useState('');
  const same = d && d === rec.replacementDecision && comment === (rec.replacementComment || '') && expectedOn === (rec.replacementExpectedOn || '') && profile === (rec.replacementProfileNotes || '');
  const opts = [['NEEDED', 'We need a replacement', ''], ['NOT_NEEDED', 'No replacement needed', 'no'], ['LATER', 'We will decide later', 'later']];
  async function go() {
    if (!d) { setErr('Choose one of the three answers first.'); return; }
    setErr('');
    try { await onSave({ decision: d, comment, expectedOn: d === 'NEEDED' ? expectedOn : '', profileNotes: d === 'NEEDED' ? profile : '' }); } catch (e) { setErr(errText(e)); }
  }
  return (
    <div>
      <div className="jd-three" role="radiogroup" aria-label="Replacement decision">
        {opts.map(([k, label, cls]) => (
          <button key={k} type="button" role="radio" aria-checked={d === k} className={`${d === k ? `on ${cls}` : ''}`} style={big ? undefined : { padding: 9, fontSize: 13.5 }} onClick={() => setD(k)}>{label}</button>
        ))}
      </div>
      <label className="field"><span>Your comment (optional)</span><textarea rows="2" maxLength={1000} value={comment} onChange={(e) => setComment(e.target.value)} /></label>
      {d === 'NEEDED' && (
        <div className="jd-grid">
          <label className="field"><span>Expected replacement by</span><input type="date" min={rec.droppedOn || undefined} value={expectedOn} onChange={(e) => setExpectedOn(e.target.value)} /></label>
          <label className="field"><span>The kind of profile you want</span><input type="text" maxLength={800} value={profile} onChange={(e) => setProfile(e.target.value)} placeholder="Skills, experience, anything useful" /></label>
        </div>
      )}
      {err && <div className="error-text">{err}</div>}
      <button type="button" className="btn btn-primary" disabled={busy || same} onClick={go} title={same ? 'Nothing is different from what is saved' : ''}>{busy ? 'Saving…' : buttonText}</button>
    </div>
  );
}

export function DecisionDialog({ rec, endpoint, onClose, onDone }) {
  const [busy, setBusy] = useState(false);
  const people = usePeople(rec.id, 'decision');
  return (
    <Modal title={`The client's answer: ${rec.candidateName}`} onClose={onClose}>
      <div className="small-muted" style={{ marginBottom: 8 }}>Enter what the client told you (for example by phone). It is saved as &quot;entered by you on the client&apos;s behalf&quot;.</div>
      <ToldLine people={people} />
      <DecisionForm
        rec={rec}
        busy={busy}
        buttonText="Save the client's answer"
        onSave={async (body) => { setBusy(true); try { const r = await api.post(endpoint, body); onDone(r.data); } finally { setBusy(false); } }}
      />
    </Modal>
  );
}

// --- link the replacement candidate ---------------------------------------------------------------------------------------------------------------
export function LinkDialog({ rec, endpoint, onClose, onDone }) {
  const [apps, setApps] = useState(null);
  const [pick, setPick] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => {
    api.get('/applications', { params: { requirementId: rec.requirementId || undefined } }).then((r) => setApps(Array.isArray(r.data) ? r.data : (r.data.rows || []))).catch(() => setApps([]));
  }, [rec.requirementId]);
  const options = useMemo(() => (apps || []).filter((a) => a.id !== rec.applicationId && a.candidateId !== rec.candidateId), [apps, rec]);
  async function save() {
    setErr('');
    try { const r = await api.post(endpoint, { applicationId: pick }); onDone(r.data); } catch (e) { setErr(errText(e)); }
  }
  return (
    <Modal title={`Replacement for ${rec.candidateName}`} onClose={onClose} footer={<button type="button" className="btn btn-primary" disabled={!pick} onClick={save}>Link this candidate</button>}>
      <div className="small-muted" style={{ marginBottom: 8 }}>Pick the new candidate who is on the same requirement. When they join, the replacement closes by itself.</div>
      <label className="field"><span>New candidate</span>
        <Combo value={pick} onChange={(e) => setPick(e.target.value)}><option value="">{apps ? 'Type a name to search' : 'Loading…'}</option>{options.map((a) => <option key={a.id} value={a.id}>{a.candidate?.name || a.candidateId}</option>)}</Combo>
      </label>
      {err && <div className="error-text">{err}</div>}
    </Modal>
  );
}

// --- the manual notice to the candidate --------------------------------------------------------------------------------------------------------
export function NoticeDialog({ rec, onClose, onDone }) {
  const [pv, setPv] = useState(null);
  const [sel, setSel] = useState({});
  const [text, setText] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    api.get(`/join-drop/${rec.id}/candidate-notice`).then((r) => {
      setPv(r.data);
      const t = {}; const s = {};
      (r.data.channels || []).forEach((c) => { t[c.channel] = { subject: c.subject, body: c.body }; s[c.channel] = !c.problem && c.channel === 'Email'; });
      setText(t); setSel(s);
    }).catch((e) => setErr(errText(e, 'Could not load the notice.')));
  }, [rec.id]);
  async function send() {
    const channels = Object.keys(sel).filter((k) => sel[k]);
    setBusy(true); setErr('');
    try {
      // one request per channel so each can carry its own edited words
      let last = null;
      for (const ch of channels) {
        // eslint-disable-next-line no-await-in-loop
        last = await api.post(`/join-drop/${rec.id}/candidate-notice`, { channels: [ch], subject: text[ch]?.subject, body: text[ch]?.body });
      }
      onDone(last ? last.data : null);
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  }
  return (
    <Modal wide title={`Notice to the candidate: ${rec.candidateName}`} onClose={onClose} footer={<button type="button" className="btn btn-primary" disabled={busy || !Object.values(sel).some(Boolean)} onClick={send}>{busy ? 'Sending…' : 'Send the notice'}</button>}>
      <div className="small-muted" style={{ marginBottom: 8 }}>Read it, change the words if you like, then send. It goes only if the candidate has an address and has not asked to be left alone. It never names the client.</div>
      {pv && pv.masterSwitchOn === false && <div className="jd-banner">&quot;Candidate emails&quot; is switched off by the Admin, so the notice will be recorded but not sent.</div>}
      {(pv?.channels || []).map((c) => (
        <div key={c.channel} className="jd-card">
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" disabled={!!c.problem} checked={!!sel[c.channel]} onChange={(e) => setSel((s) => ({ ...s, [c.channel]: e.target.checked }))} />
            <b>{c.channel}</b>{c.reach && <span className="small-muted">{c.reach}</span>}
          </label>
          {c.problem ? <div className="jd-banner red">{c.problem}</div> : (
            <>
              {c.channel === 'Email' && <label className="field"><span>Subject</span><input type="text" maxLength={200} value={text[c.channel]?.subject || ''} onChange={(e) => setText((t) => ({ ...t, [c.channel]: { ...t[c.channel], subject: e.target.value } }))} /></label>}
              <label className="field"><span>Message</span><textarea rows="5" maxLength={1000} value={text[c.channel]?.body || ''} onChange={(e) => setText((t) => ({ ...t, [c.channel]: { ...t[c.channel], body: e.target.value } }))} /></label>
              {c.channel === 'WhatsApp' && !c.connected && <div className="small-muted">WhatsApp is not connected, so this would only be recorded.</div>}
            </>
          )}
        </div>
      ))}
      {err && <div className="error-text">{err}</div>}
    </Modal>
  );
}

// --- the history list, the journey, who was told -------------------------------------------------------------------------------------------------
export function HistoryList({ history }) {
  if (!history || !history.length) return <div className="small-muted">No history yet.</div>;
  return (
    <ul className="jd-hist">
      {history.map((e) => (
        <li key={e.id}>
          <div className="when">{when(e.at)}</div>
          <div>
            <div><b>{e.kind === 'CLIENT_DECISION' ? 'Replacement decision' : (e.summary || '').split(':')[0]}</b>{e.onBehalf ? <> <StatusChip status="Entered on the client's behalf" tone="yellow" /></> : null}</div>
            <div style={{ overflowWrap: 'anywhere' }}>{e.summary}</div>
            {e.note && <div className="by">Reason given: {e.note}</div>}
            <div className="by">{[e.byName, e.fromWhere].filter(Boolean).join(' · ')}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function Journey({ journey }) {
  if (!journey) return null;
  return (
    <>
      <div className="small-muted" style={{ marginBottom: 6 }}>Every date comes from what was recorded. &quot;Not recorded&quot; means it happened but nobody wrote the date. &quot;Not yet&quot; means it has not happened.</div>
      <ul className="jd-ms">
        {journey.milestones.map((m) => (
          <li key={m.key}>
            <div className={`day${m.state === 'Not yet' ? ' pending' : (m.state === 'Not recorded' ? ' nr' : '')}`}>{m.state === 'Done' ? dmy(m.day) : m.state}</div>
            <div>
              <div>{m.label}</div>
              <div className="sub">{[m.at ? when(m.at).replace(/^.*?(\d{2}:\d{2})$/, '$1') : null, m.who ? `by ${m.who}` : null, m.detail].filter(Boolean).join(' · ')}</div>
            </div>
            <div>{m.elapsed ? <span className="elapsed">{`${m.elapsed.label}: ${m.elapsed.days} day${m.elapsed.days === 1 ? '' : 's'}`}</span> : null}</div>
          </li>
        ))}
      </ul>
    </>
  );
}

export function ToldTable({ told, emailsOn }) {
  if (!told || !told.length) return <div className="small-muted">Nobody was told yet.</div>;
  return (
    <>
      {emailsOn === false && <div className="jd-banner">Emails are switched off at the moment. Bells and tasks still happen. Turn them on in Attendance, Who gets told.</div>}
      <table className="jd-told"><tbody>
        {told.map((n, i) => (
          // eslint-disable-next-line react/no-array-index-key
          <tr key={i}><td className="small-muted">{when(n.createdAt)}</td><td>{n.recipientName || n.party}</td><td>{n.channel}</td><td>{n.status}</td></tr>
        ))}
      </tbody></table>
    </>
  );
}
