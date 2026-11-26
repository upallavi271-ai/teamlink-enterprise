import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import TabStrip from '../ui/TabStrip.jsx';
import '../interviews/interviewTools.css';

// ---------------------------------------------------------------------------
// CANDIDATE > OUTREACH TOOLS (market wave 2026-11-21; server routes/mktComms.js + routes/mktInterviews.js). Needs the right to contact the person.
//   Write       an AI draft (or a reply to their last message), sent from your own mailbox or copied (08.12 / 08.01)
//   Sequences   email / SMS / WhatsApp steps with waits + LinkedIn / call tasks; stops when they reply (08.05 / 08.06)
//   Call notes  a call transcript / recording -> notice period, CTC... as suggestions to accept (08.10)
//   Email       is the address real (08.11), opens / clicks (08.04), my mailbox (08.01)
//   Tests       send a job's test, see the score (07.15)
//   Extension   your key for the LinkedIn browser extension (10.11)
// ---------------------------------------------------------------------------
const errOf = (e) => (e && e.response && e.response.data && e.response.data.error) || 'That did not work. Please try again.';
const when = (v) => (v ? new Date(v).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '-');
const SUB = [
  { key: 'write', label: 'Write', hint: 'An AI draft of an email or message to this person, sent from your mailbox or copied.' },
  { key: 'seq', label: 'Sequences', hint: 'Several messages and tasks over a few days; stops when they reply.' },
  { key: 'call', label: 'Call notes', hint: 'Paste a call transcript: TeamLink suggests notice period, CTC and more.' },
  { key: 'email', label: 'Email', hint: 'Is the address real, were our emails opened, and your own mailbox.' },
  { key: 'tests', label: 'Tests', hint: 'Send the job\'s online test and see the score.' },
  { key: 'ext', label: 'Browser extension', hint: 'Add LinkedIn, Naukri, Shine and foundit profiles to TeamLink from the browser.', more: true },
];

export default function OutreachTools({ candidateId, applicationId }) {
  const [sub, setSub] = useState('write');
  return (
    <div className="card section" data-testid="outreach-tools">
      <TabStrip small label="Outreach tools" tabs={SUB} value={sub} onChange={setSub} />
      {sub === 'write' && <Write candidateId={candidateId} applicationId={applicationId} />}
      {sub === 'seq' && <Sequences candidateId={candidateId} applicationId={applicationId} />}
      {sub === 'call' && <CallNotes candidateId={candidateId} applicationId={applicationId} />}
      {sub === 'email' && <EmailTools candidateId={candidateId} />}
      {sub === 'tests' && <Tests applicationId={applicationId} />}
      {sub === 'ext' && <ExtensionKey />}
    </div>
  );
}

function Write({ candidateId, applicationId }) {
  const [purpose, setPurpose] = useState('follow_up'); const [channel, setChannel] = useState('Email'); const [note, setNote] = useState('');
  const [d, setD] = useState(null); const [subject, setSubject] = useState(''); const [body, setBody] = useState(''); const [box, setBox] = useState(null); const [err, setErr] = useState(''); const [msg, setMsg] = useState('');
  useEffect(() => { api.get('/ats/mkt/mailbox').then((r) => setBox(r.data.mailbox)).catch(() => null); }, []);
  const run = async (fn) => { setErr(''); setMsg(''); try { await fn(); } catch (e) { setErr(errOf(e)); } };
  const draft = () => run(async () => { const r = await api.post(`/ats/mkt/candidates/${candidateId}/draft`, { purpose, channel, note, applicationId }); setD(r.data); setSubject(r.data.subject || ''); setBody(r.data.body); });
  const purposes = (d && d.purposes) || [{ key: 'follow_up', label: 'Follow up (no reply yet)' }, { key: 'interview_invite', label: 'Invite to interview' }, { key: 'reminder', label: 'Interview reminder' }, { key: 'documents', label: 'Ask for documents' }, { key: 'job_pitch', label: 'Tell them about a job' }, { key: 'rejection', label: 'Not selected (kind)' }, { key: 'reply', label: 'Reply to their last message' }];
  return (
    <div className="ivt-body">
      <div className="ivt-row">
        <select value={purpose} onChange={(e) => setPurpose(e.target.value)} aria-label="What the message is for">{purposes.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</select>
        <select value={channel} onChange={(e) => setChannel(e.target.value)} aria-label="Channel"><option>Email</option><option>WhatsApp</option><option>SMS</option></select>
        <input type="text" placeholder="Anything to add (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
        <button type="button" className="btn btn-sm btn-primary" onClick={draft}>✨ Draft it</button>
      </div>
      {d && (
        <>
          <div className="small-muted">{d.source}. The AI sees only the job and the step - never the person's contact details or pay.</div>
          {channel === 'Email' && <input type="text" value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Subject" />}
          <textarea rows="7" value={body} onChange={(e) => setBody(e.target.value)} aria-label="Message" />
          <div className="ivt-row">
            <button type="button" className="btn btn-sm" onClick={() => { if (navigator.clipboard) navigator.clipboard.writeText(channel === 'Email' ? `${subject}\n\n${body}` : body); setMsg('Copied. Paste it in the Conversation tab or your WhatsApp.'); }}>Copy</button>
            {channel === 'Email' && box && box.saved && <button type="button" className="btn btn-sm btn-primary" onClick={() => run(async () => { const r = await api.post(`/ats/mkt/candidates/${candidateId}/mailbox-send`, { subject, text: body, applicationId }); setMsg(`Sent from ${box.address}${r.data.tracked ? ' (opens tracked)' : ''}${r.data.sandbox ? ' - test server, nothing really left' : ''}.`); })}>Send from my mailbox</button>}
            {channel === 'Email' && !(box && box.saved) && <span className="small-muted">Connect your mailbox (Email tab) to send it from here.</span>}
          </div>
        </>
      )}
      {msg && <div className="notice">{msg}</div>}{err && <div className="error-text">{err}</div>}
    </div>
  );
}

const STEP_CH = ['Email', 'SMS', 'WhatsApp', 'LinkedIn', 'Call'];
function Sequences({ candidateId, applicationId }) {
  const [list, setList] = useState(null); const [runs, setRuns] = useState([]); const [pick, setPick] = useState(''); const [build, setBuild] = useState(null); const [err, setErr] = useState(''); const [msg, setMsg] = useState('');
  const load = useCallback(() => {
    api.get('/ats/mkt/sequences').then((r) => { setList(r.data); if (!pick && r.data.rows[0]) setPick(r.data.rows[0].id); }).catch((e) => setErr(errOf(e)));
    api.get(`/ats/mkt/candidates/${candidateId}/sequences`).then((r) => setRuns(r.data.rows)).catch(() => null);
  }, [candidateId, pick]);
  useEffect(() => { load(); }, [load]);
  const run = async (fn) => { setErr(''); setMsg(''); try { await fn(); } catch (e) { setErr(errOf(e)); } };
  if (!list) return err ? <div className="error-text">{err}</div> : <div className="small-muted">Loading…</div>;
  const setS = (i, patch) => setBuild((b) => ({ ...b, steps: b.steps.map((s, n) => (n === i ? { ...s, ...patch } : s)) }));
  return (
    <div className="ivt-body">
      {!list.switchOn && <div className="notice">Sequences are switched off (an Admin turns them on). You can build them now.</div>}
      {runs.map((r) => r && (
        <div key={r.id} className="mkt-q">
          <div className="ivt-row"><b>{r.name}</b><span className="small-muted">{r.status}{r.stopReason ? ` - ${r.stopReason}` : ''} · started {when(r.startedAt)}</span>
            {r.status === 'running' && <button type="button" className="btn btn-sm btn-danger" onClick={() => run(async () => { await api.post(`/ats/mkt/sequence-runs/${r.id}/stop`, {}); load(); })}>Stop</button>}</div>
          {r.steps.map((s) => (
            <div key={s.i} className="kv"><span className="k">{s.i + 1}. {s.channel} · {when(s.dueAt)}</span>
              <span>{s.status === 'task' ? <>to do: {s.body} <button type="button" className="btn btn-sm" onClick={() => run(async () => { await api.post(`/ats/mkt/sequence-runs/${r.id}/tasks/${s.i}/done`, {}); load(); })}>Done</button></> : `${s.status}${s.reason ? ` (${s.reason})` : ''}`}</span></div>
          ))}
        </div>
      ))}
      {list.rows.length > 0 && (
        <div className="ivt-row">
          <select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Sequence">{list.rows.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name} ({s.steps.length} steps)</option>)}</select>
          <button type="button" className="btn btn-sm btn-primary" disabled={!list.switchOn || !pick} onClick={() => run(async () => { await api.post(`/ats/mkt/candidates/${candidateId}/sequences`, { sequenceId: pick, applicationId }); setMsg('Started. It stops by itself when they reply.'); load(); })}>Start for this person</button>
        </div>
      )}
      {!build && list.canEdit && <button type="button" className="btn btn-sm" onClick={() => setBuild({ name: '', steps: [{ channel: 'Email', waitDays: 0, subject: 'About {{job}}', body: 'Hi {{first}}, ' }] })}>+ Build a sequence</button>}
      {build && (
        <div className="mkt-q">
          <input type="text" placeholder="Sequence name" value={build.name} onChange={(e) => setBuild({ ...build, name: e.target.value })} />
          <div className="small-muted">{'{{first}}'} = first name, {'{{job}}'} = job title, {'{{me}}'} = your name. LinkedIn and Call steps are tasks for you on their day.</div>
          {build.steps.map((s, i) => (
            <div key={i} className="ivt-row">
              <span className="small-muted">{i + 1}.</span>
              <select value={s.channel} onChange={(e) => setS(i, { channel: e.target.value })}>{STEP_CH.map((c) => <option key={c}>{c}</option>)}</select>
              <label className="small-muted">after <input type="number" min="0" max="30" style={{ width: 50 }} value={s.waitDays} onChange={(e) => setS(i, { waitDays: Number(e.target.value) })} /> days</label>
              {s.channel === 'Email' && <input type="text" value={s.subject || ''} placeholder="Subject" onChange={(e) => setS(i, { subject: e.target.value })} />}
              <input type="text" value={s.body} placeholder={['LinkedIn', 'Call'].includes(s.channel) ? 'What to do' : 'Message'} onChange={(e) => setS(i, { body: e.target.value })} />
              <button type="button" className="btn btn-sm btn-ghost" aria-label="Remove step" onClick={() => setBuild({ ...build, steps: build.steps.filter((_, n) => n !== i) })}>✕</button>
            </div>
          ))}
          <div className="ivt-row">
            <button type="button" className="btn btn-sm" onClick={() => setBuild({ ...build, steps: [...build.steps, { channel: 'LinkedIn', waitDays: 2, body: '' }] })}>+ Step</button>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => run(async () => { await api.post('/ats/mkt/sequences', build); setBuild(null); load(); })}>Save sequence</button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setBuild(null)}>Cancel</button>
          </div>
        </div>
      )}
      {msg && <div className="notice">{msg}</div>}{err && <div className="error-text">{err}</div>}
    </div>
  );
}

function CallNotes({ candidateId, applicationId }) {
  const [d, setD] = useState(null); const [text, setText] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.get(`/ats/mkt/candidates/${candidateId}/call-notes`).then((r) => setD(r.data)).catch((e) => setErr(errOf(e))), [candidateId]);
  useEffect(() => { load(); }, [load]);
  const run = async (fn) => { setErr(''); setBusy(true); try { await fn(); } catch (e) { setErr(errOf(e)); } setBusy(false); };
  if (!d) return err ? <div className="error-text">{err}</div> : <div className="small-muted">Loading…</div>;
  const upload = (file) => run(async () => { const fd = new FormData(); fd.append('file', file); if (applicationId) fd.append('applicationId', applicationId); await api.post(`/ats/mkt/candidates/${candidateId}/call-notes`, fd, { headers: { 'Content-Type': 'multipart/form-data' } }); load(); });
  return (
    <div className="ivt-body">
      <div className="small-muted">Paste what was said on the call (or upload the recording{d.speech ? '' : ' - this server has no speech engine, so paste the words'}). Nothing on the profile changes until you accept a suggestion.</div>
      <textarea rows="5" value={text} onChange={(e) => setText(e.target.value)} placeholder="Recruiter: What is your notice period? Candidate: 30 days..." />
      <div className="ivt-row">
        <button type="button" className="btn btn-sm btn-primary" disabled={!text.trim() || busy} onClick={() => run(async () => { await api.post(`/ats/mkt/candidates/${candidateId}/call-notes`, { transcript: text, applicationId }); setText(''); load(); })}>Find the facts</button>
        <label className="btn btn-sm">Upload call recording<input type="file" accept="audio/*" hidden onChange={(e) => e.target.files[0] && upload(e.target.files[0])} /></label>
      </div>
      {d.rows.map((n) => n && (
        <div key={n.id} className="mkt-q">
          <div className="small-muted">{when(n.createdAt)} · {n.createdBy} · {n.transcriptSource}</div>
          {n.summary && <div>{n.summary}</div>}
          {n.suggestions.length === 0 && <div className="small-muted">No facts were found in this call.</div>}
          {n.suggestions.map((s) => (
            <div key={s.field} className="kv"><span className="k">{s.label}</span>
              <span><b>{String(s.value)}</b> <span className="small-muted">(now: {s.current == null ? '-' : String(s.current)} · {s.by})</span>{' '}
                {s.status === 'pending' ? <>
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => run(async () => { await api.post(`/ats/mkt/call-notes/${n.id}/${s.field}`, { accept: true }); load(); })}>Accept</button>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => run(async () => { await api.post(`/ats/mkt/call-notes/${n.id}/${s.field}`, { accept: false }); load(); })}>Dismiss</button>
                </> : <span className="small-muted">{s.status}</span>}
                {s.evidence && <div className="small-muted">"{s.evidence}"</div>}
              </span></div>
          ))}
        </div>
      ))}
      {err && <div className="error-text">{err}</div>}
    </div>
  );
}

function EmailTools({ candidateId }) {
  const [chk, setChk] = useState(null); const [tr, setTr] = useState(null); const [box, setBox] = useState(null); const [form, setForm] = useState(null); const [err, setErr] = useState(''); const [msg, setMsg] = useState('');
  const load = useCallback(() => {
    api.get(`/ats/mkt/candidates/${candidateId}/email-tracking`).then((r) => setTr(r.data)).catch(() => null);
    api.get('/ats/mkt/mailbox').then((r) => setBox(r.data)).catch(() => null);
  }, [candidateId]);
  useEffect(() => { load(); }, [load]);
  const run = async (fn) => { setErr(''); setMsg(''); try { await fn(); } catch (e) { setErr(errOf(e)); } };
  const tone = (v) => ({ valid: 'active', risky: 'pending', invalid: 'rejected' }[v] || '');
  return (
    <div className="ivt-body">
      <div className="mkt-sec">
        <h3>Is the email address real?</h3>
        <button type="button" className="btn btn-sm" onClick={() => run(async () => { const r = await api.post(`/ats/mkt/candidates/${candidateId}/email-check`, {}); setChk(r.data); })}>Check the address</button>
        {chk && <div className="notice"><span className={`status ${tone(chk.verdict)}`}>{chk.verdict}</span> {chk.reasons.join(' ')}{chk.mx && chk.mx.note ? ` ${chk.mx.note}` : ''}</div>}
      </div>
      <div className="mkt-sec">
        <h3>Opens and clicks</h3>
        {tr && <div className="small-muted">{tr.on ? `On. ${tr.privacy}` : 'Tracking is switched off (an Admin turns it on). Nothing is tracked.'}</div>}
        {tr && tr.rows.map((r, i) => <div key={i} className="kv"><span className="k">{r.subject} · {when(r.sentAt)}</span><span>{r.opened ? `opened ${r.opens}x (first ${when(r.firstOpenAt)})` : 'not opened yet'}{r.clicks ? ` · ${r.clicks} click(s)` : ''}</span></div>)}
        {tr && tr.on && !tr.rows.length && <div className="small-muted">No tracked emails to this person yet.</div>}
      </div>
      <div className="mkt-sec">
        <h3>My mailbox</h3>
        <div className="small-muted">Send candidate emails from your own address and get their replies here. {box && box.oauthNote}</div>
        {box && box.mailbox && !form && <div className="kv"><span className="k">{box.mailbox.address}</span><span>{box.mailbox.status}{box.mailbox.lastError ? ` - ${box.mailbox.lastError}` : ''} <button type="button" className="btn btn-sm" onClick={() => run(async () => { const r = await api.post('/ats/mkt/mailbox/check', {}); setMsg(r.data.message); load(); })}>Check now</button> <button type="button" className="btn btn-sm btn-ghost" onClick={() => setForm({ ...box.mailbox, password: '' })}>Change</button> <button type="button" className="btn btn-sm btn-ghost" onClick={() => run(async () => { await api.delete('/ats/mkt/mailbox'); load(); })}>Remove</button></span></div>}
        {box && !box.mailbox && !form && <button type="button" className="btn btn-sm" onClick={() => setForm({ address: '', imapHost: '', imapPort: 993, smtpHost: '', smtpPort: 465, password: '' })}>Connect my mailbox</button>}
        {form && (
          <div className="mkt-grid">
            <label className="field">Email address<input type="email" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></label>
            <label className="field">IMAP server<input type="text" placeholder="imap.gmail.com" value={form.imapHost} onChange={(e) => setForm({ ...form, imapHost: e.target.value })} /></label>
            <label className="field">SMTP server<input type="text" placeholder="smtp.gmail.com" value={form.smtpHost} onChange={(e) => setForm({ ...form, smtpHost: e.target.value })} /></label>
            <label className="field">App password<input type="password" autoComplete="new-password" placeholder={form.saved ? 'saved - type to replace' : ''} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
            <div className="ivt-row"><button type="button" className="btn btn-sm btn-primary" onClick={() => run(async () => { await api.put('/ats/mkt/mailbox', form); setForm(null); setMsg('Saved (the password is kept encrypted).'); load(); })}>Save</button><button type="button" className="btn btn-sm btn-ghost" onClick={() => setForm(null)}>Cancel</button></div>
          </div>
        )}
        {box && <div className="small-muted">{box.syncOn ? 'Replies are read every 5 minutes.' : 'Reading replies by itself is switched off (Admin); press "Check now".'}</div>}
      </div>
      {msg && <div className="notice">{msg}</div>}{err && <div className="error-text">{err}</div>}
    </div>
  );
}

function Tests({ applicationId }) {
  const [d, setD] = useState(null); const [pick, setPick] = useState(''); const [link, setLink] = useState(null); const [err, setErr] = useState('');
  const load = useCallback(() => { if (!applicationId) return; api.get(`/ats/mkt/applications/${applicationId}/assessments`).then((r) => { setD(r.data); if (r.data.tests[0]) setPick((p) => p || r.data.tests[0].id); }).catch((e) => setErr(errOf(e))); }, [applicationId]);
  useEffect(() => { load(); }, [load]);
  if (!applicationId) return <div className="small-muted">Add this person to a requirement first: tests belong to a job.</div>;
  if (!d) return err ? <div className="error-text">{err}</div> : <div className="small-muted">Loading…</div>;
  const send = (email) => (async () => { setErr(''); try { const r = await api.post(`/ats/mkt/interviews/${applicationId}/assessments/${pick}/send`, { email }); setLink(r.data); load(); } catch (e) { setErr(errOf(e)); } })();
  return (
    <div className="ivt-body">
      {!d.switchOn && <div className="notice">Sending tests is switched off (an Admin turns it on).</div>}
      {d.tests.length === 0 && <div className="small-muted">This job has no test yet: build one on the requirement, Kits &amp; tests tab.</div>}
      {d.tests.length > 0 && d.canSend && (
        <div className="ivt-row">
          <select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Test">{d.tests.map((t) => <option key={t.id} value={t.id}>{t.title} ({t.count} q, {t.minutes} min)</option>)}</select>
          <button type="button" className="btn btn-sm" disabled={!d.switchOn} onClick={() => send(false)}>Make the link</button>
          <button type="button" className="btn btn-sm btn-primary" disabled={!d.switchOn} onClick={() => send(true)}>Email the link</button>
        </div>
      )}
      {link && <div className="notice"><a href={link.link} target="_blank" rel="noreferrer">{link.link}</a> · {link.outcome}</div>}
      {d.rows.map((r) => <div key={r.token} className="kv"><span className="k">{r.title} · sent {when(r.sentAt)} by {r.sentBy}</span><span>{r.status === 'submitted' ? <b className={r.passed ? 'ok-text' : 'error-text'}>{r.percent}% {r.passed ? 'passed' : 'below the pass mark'}</b> : r.status}{r.review && r.review.late ? ' · after the time limit' : ''}</span></div>)}
      {err && <div className="error-text">{err}</div>}
    </div>
  );
}

function ExtensionKey() {
  const [d, setD] = useState(null); const [key, setKey] = useState(''); const [err, setErr] = useState('');
  const load = () => api.get('/ats/mkt/extension-key').then((r) => setD(r.data)).catch((e) => setErr(errOf(e)));
  useEffect(() => { load(); }, []);
  if (!d) return err ? <div className="error-text">{err}</div> : <div className="small-muted">Loading…</div>;
  return (
    <div className="ivt-body">
      <div className="small-muted">The TeamLink browser extension (2.0) adds the profile you are looking at on <b>LinkedIn, Naukri (incl. Resdex), Shine or foundit</b> as a candidate - name, contact, experience, CTC, expected CTC, notice period, skills - and can put it straight on one of your requirements. You check and correct the details before it is saved; the same person found by link, email or phone is not added twice. It uses your own key (only your rights).</div>
      <div className="small-muted"><b>Install:</b> <a href="/downloads/teamlink-extension.zip" download>download the extension</a>, unzip it, open Chrome &gt; Extensions, switch on Developer mode, press <i>Load unpacked</i> and pick the unzipped folder. Then open its Settings and paste the TeamLink address and your key. Already on 1.0? Remove it first, then load 2.0.</div>
      {d.key && <div className="kv"><span className="k">Your key …{d.key.hint}</span><span>made {when(d.key.createdAt)}{d.key.lastUsedAt ? `, last used ${when(d.key.lastUsedAt)}` : ''}</span></div>}
      {key && <div className="notice">Copy it now - it is shown once: <code className="ivt-code">{key}</code></div>}
      <div className="ivt-row">
        {d.mayAdd && <button type="button" className="btn btn-sm btn-primary" onClick={async () => { try { const r = await api.post('/ats/mkt/extension-key', {}); setKey(r.data.key); load(); } catch (e) { setErr(errOf(e)); } }}>{d.key ? 'Make a new key (the old one stops)' : 'Make my key'}</button>}
        {d.key && <button type="button" className="btn btn-sm btn-ghost" onClick={async () => { await api.delete('/ats/mkt/extension-key'); setKey(''); load(); }}>Remove my key</button>}
        {!d.mayAdd && <span className="small-muted">Your role cannot add candidates, so it has no extension key.</span>}
      </div>
      {err && <div className="error-text">{err}</div>}
    </div>
  );
}
