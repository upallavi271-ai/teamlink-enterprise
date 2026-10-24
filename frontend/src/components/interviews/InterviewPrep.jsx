import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../../api';
import { Modal } from '../proto.jsx';
import InterviewTell from './InterviewTell.jsx';
import './InterviewPrep.css';

// ---------------------------------------------------------------------------
// INTERVIEW PREP (user note, 2026-10-10: "AI interview (or) client interviews unnappudu, JD ni base
// chesukoni SUGGESTED QUESTIONS candidate ki prepare avvadaniki untundi").
//
//   <InterviewPrepCard applicationId />      the card: likely questions from the job description (AI or
//                                            template - the label says which), "Revise" tips, what to do on
//                                            the day. A recruiter / TL can edit, add, remove, write again and
//                                            send it to the candidate. A BDE / Manager only reads it.
//   <InterviewPrepButton applicationId />    a small button that opens the card in a window (AI tab rows)
//   <InterviewTellWithPrep ... />            the "Booked - now tell them" window + a checked-by-default
//                                            "Send preparation questions to {name}" line with Preview / edit.
//
// The server (routes/interviewPrep.js) decides who may edit and send; nothing here is security.
// Plain words, big buttons, no dropdown menus.
// ---------------------------------------------------------------------------
const TYPE_WORD = { client: 'Client interview', team: 'Team interview', ai: 'AI interview' };
const when = (d) => (d ? new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }) : '');
const errText = (e, fallback) => e?.response?.data?.error || fallback;
const clone = (groups) => groups.map((g) => ({ ...g, questions: [...g.questions] }));

export function InterviewPrepCard({ applicationId, type: askedType = '', onChanged = null, compact = false }) {
  const [type, setType] = useState(askedType);
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState(null); // { groups, tips } while the person edits
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');
  const [chan, setChan] = useState(null); // { email, connected }
  const [sendOut, setSendOut] = useState(null);
  const [show, setShow] = useState(false); // "what the candidate reads"
  const [sure, setSure] = useState(false); // "write again" replaces edits
  const [alsoWa, setAlsoWa] = useState(false);
  const [alsoSms, setAlsoSms] = useState(false);
  const [copied, setCopied] = useState('');

  const load = useCallback(async (t = type) => {
    try {
      const r = await api.get(`/ats/interviews/${applicationId}/prep`, { params: t ? { type: t } : {} });
      setData(r.data); setErr(''); setDraft(null);
      if (!t) setType(r.data.type);
      if (r.data.canSend) {
        api.get(`/ats/interviews/${applicationId}/prep/channels`, { params: { type: r.data.type } }).then((c) => setChan(c.data)).catch(() => setChan(null));
      } else setChan(null);
    } catch (e) { setErr(errText(e, 'Could not open the preparation questions. Please try again.')); }
  }, [applicationId, type]);
  useEffect(() => { setData(null); load(askedType || type); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [applicationId]);

  const pickType = (t) => { setType(t); setData(null); setSendOut(null); setNote(''); load(t); };

  if (err && !data) return <div className="msg-box red">{err}</div>;
  if (!data) return <div className="ipc-load">Getting the questions ready… <small>(the first time can take a little while)</small></div>;

  const editing = !!draft;
  const groups = editing ? draft.groups : data.pack.groups;
  const tips = editing ? draft.tips : data.pack.tips;
  const canEdit = data.canEdit;
  const startEdit = () => setDraft({ groups: clone(data.pack.groups), tips: [...data.pack.tips] });
  const dirty = editing && JSON.stringify([draft.groups.map((g) => g.questions), draft.tips]) !== JSON.stringify([data.pack.groups.map((g) => g.questions), data.pack.tips]);
  const setQ = (gi, qi, v) => setDraft((d) => { const groupsN = clone(d.groups); groupsN[gi].questions[qi] = v; return { ...d, groups: groupsN }; });
  const delQ = (gi, qi) => setDraft((d) => { const groupsN = clone(d.groups); groupsN[gi].questions.splice(qi, 1); return { ...d, groups: groupsN }; });
  const addQ = (gi) => setDraft((d) => { const groupsN = clone(d.groups); groupsN[gi].questions.push(''); return { ...d, groups: groupsN }; });
  const setTip = (i, v) => setDraft((d) => { const t = [...d.tips]; t[i] = v; return { ...d, tips: t }; });
  const delTip = (i) => setDraft((d) => ({ ...d, tips: d.tips.filter((_, k) => k !== i) }));
  const addTip = () => setDraft((d) => ({ ...d, tips: [...d.tips, 'Revise: '] }));

  async function save() {
    setBusy('save'); setErr(''); setNote('');
    try {
      const body = { type: data.type, version: data.pack.version, groups: Object.fromEntries(draft.groups.map((g) => [g.key, g.questions])), tips: draft.tips };
      const r = await api.put(`/ats/interviews/${applicationId}/prep`, body);
      setData(r.data); setDraft(null); setNote([r.data.saved, ...(r.data.warnings || [])].filter(Boolean).join(' '));
      if (onChanged) onChanged(r.data);
    } catch (e) { setErr(errText(e, 'Could not save. Please try again.')); } finally { setBusy(''); }
  }
  async function again() {
    setBusy('again'); setErr(''); setNote(''); setSure(false);
    try {
      const r = await api.post(`/ats/interviews/${applicationId}/prep/regenerate`, { type: data.type });
      setData(r.data); setDraft(null); setNote(r.data.saved || 'Written again.');
      if (onChanged) onChanged(r.data);
    } catch (e) { setErr(errText(e, 'Could not write it again. Please try again.')); } finally { setBusy(''); }
  }
  async function send(force = false) {
    setBusy('send'); setErr(''); setSendOut(null);
    try {
      const channels = ['Email', ...(alsoWa ? ['WhatsApp'] : []), ...(alsoSms ? ['SMS'] : [])];
      const r = await api.post(`/ats/interviews/${applicationId}/prep/send`, { type: data.type, channels, again: force });
      setSendOut(r.data); await load(data.type);
      if (onChanged) onChanged(r.data);
    } catch (e) { setErr(errText(e, 'Could not send. Please try again.')); } finally { setBusy(''); }
  }
  async function copyLink() {
    setErr(''); setCopied('');
    try {
      const r = await api.post(`/ats/interviews/${applicationId}/prep/link`, { type: data.type });
      try { await navigator.clipboard.writeText(r.data.link); setCopied('Link copied. Paste it in WhatsApp or SMS.'); } catch { setCopied(r.data.link); }
      load(data.type);
    } catch (e) { setErr(errText(e, 'Could not make the link.')); }
  }

  const sourceTone = data.pack.source === 'ai' ? 'blue' : 'orange';
  const mail = chan && chan.email;
  const mailOk = mail && mail.state === 'send';
  const nameFirst = String(data.candidateName || '').replace(/^ZZTEST\S*\s*/i, '').split(/\s+/)[0] || 'the candidate';

  return (
    <div className={`ipc${compact ? ' ipc-compact' : ''}`}>
      <div className="ipc-types" role="group" aria-label="Which interview">
        {data.types.map((t) => (
          <button key={t.key} type="button" className={`ipc-type${t.key === data.type ? ' is-on' : ''}`} onClick={() => pickType(t.key)} disabled={!!busy || editing}>{t.label}</button>
        ))}
      </div>
      <div className="ipc-meta">
        <span className={`ipc-chip ${sourceTone}`} title={data.pack.aiNote || ''}>{data.pack.sourceLabel}</span>
        <span className="small-muted">{data.job}{data.round ? ` · Round ${data.round}` : ''}</span>
      </div>
      {data.pack.source === 'template' && data.pack.aiNote && <div className="small-muted ipc-why">Written from the requirement words by a template. {data.pack.aiNote}</div>}
      {data.stale && <div className="msg-box orange">The job description changed after these questions were saved. {canEdit ? 'Press “Write again” to refresh them (your edits will go).' : 'Your recruiter can refresh them.'}</div>}
      {!canEdit && <div className="msg-box blue">You can read these questions. Your recruiter edits them and sends them to the candidate.</div>}
      {err && <div className="msg-box red">{err}</div>}
      {note && <div className="ivt-ok" role="status">{note}</div>}

      {groups.map((g, gi) => (
        <section key={g.key} className="ipc-group">
          <h4>{g.title}</h4>
          {g.questions.length === 0 && !editing && <div className="small-muted">Nothing here.</div>}
          <ol className={g.key === 'ask' ? 'ipc-dash' : ''}>
            {g.questions.map((q, qi) => (
              <li key={`${g.key}-${qi}`}>
                {editing ? (
                  <span className="ipc-edit">
                    <textarea value={q} rows={Math.max(2, Math.ceil(q.length / 55))} maxLength={240} onChange={(e) => setQ(gi, qi, e.target.value)} aria-label={`${g.title} question ${qi + 1}`} />
                    <button type="button" className="btn btn-sm btn-ghost ipc-x" onClick={() => delQ(gi, qi)} aria-label="Remove this question">Remove</button>
                  </span>
                ) : q}
              </li>
            ))}
          </ol>
          {editing && <button type="button" className="btn btn-sm" onClick={() => addQ(gi)}>+ Add a question</button>}
        </section>
      ))}

      <section className="ipc-group">
        <h4>Revise before the interview</h4>
        <ul>
          {tips.map((t, i) => (
            <li key={`t${i}`}>
              {editing ? (
                <span className="ipc-edit">
                  <input type="text" value={t} maxLength={240} onChange={(e) => setTip(i, e.target.value)} aria-label={`Tip ${i + 1}`} />
                  <button type="button" className="btn btn-sm btn-ghost ipc-x" onClick={() => delTip(i)}>Remove</button>
                </span>
              ) : t}
            </li>
          ))}
        </ul>
        {editing && <button type="button" className="btn btn-sm" onClick={addTip}>+ Add a tip</button>}
      </section>

      <section className="ipc-group">
        <h4>On the day <small>(from the booking)</small></h4>
        <ul>{data.candidate.onTheDay.map((t, i) => <li key={`d${i}`}>{t}</li>)}</ul>
      </section>

      {data.personal && (data.personal.questions.length > 0 || data.personal.tips.length > 0) && (
        <section className="ipc-group">
          <h4>From {nameFirst}&apos;s resume <small>(added for this person)</small></h4>
          <ul>{[...data.personal.questions, ...data.personal.tips].map((t, i) => <li key={`p${i}`}>{t}</li>)}</ul>
        </section>
      )}

      {canEdit && (
        <>
          <div className="ipc-actions">
            {editing ? (
              <>
                <button type="button" className="btn btn-primary" disabled={!dirty || busy === 'save'} onClick={save}>{busy === 'save' ? 'Saving…' : 'Save changes'}</button>
                <button type="button" className="btn" onClick={() => setDraft(null)} disabled={busy === 'save'}>Cancel</button>
              </>
            ) : (
              <>
                <button type="button" className="btn btn-primary" disabled={!mailOk || busy === 'send'} onClick={() => send(false)}>
                  {busy === 'send' ? 'Sending…' : (data.sentThisVersion ? 'Sent - send again' : 'Send to candidate by Mail')}
                </button>
                <button type="button" className="btn" onClick={startEdit}>Edit the questions</button>
                {sure ? (
                  <span className="ipc-sure">
                    {data.pack.edited ? 'This replaces your edits. ' : ''}Write again?
                    <button type="button" className="btn btn-sm btn-primary" onClick={again} disabled={busy === 'again'}>{busy === 'again' ? 'Writing…' : 'Yes, write again'}</button>
                    <button type="button" className="btn btn-sm" onClick={() => setSure(false)}>No</button>
                  </span>
                ) : <button type="button" className="btn" onClick={() => (data.pack.edited ? setSure(true) : again())} disabled={busy === 'again'}>{busy === 'again' ? 'Writing…' : 'Write again'}</button>}
                <button type="button" className="btn btn-ghost" onClick={() => setShow((v) => !v)}>{show ? 'Hide what the candidate reads' : 'See what the candidate reads'}</button>
                <button type="button" className="btn btn-ghost" onClick={copyLink}>Copy the candidate&apos;s page link</button>
              </>
            )}
          </div>
          {!editing && chan && !mailOk && <div className="msg-box orange ipc-why"><b>Mail:</b> {mail ? (mail.reason || 'Cannot be sent.') : 'Cannot be checked.'} {mail && mail.state !== 'none' && 'You can still copy the page link and send it from your own WhatsApp.'}</div>}
          {!editing && chan && chan.connected && (chan.connected.WhatsApp || chan.connected.SMS) && (
            <div className="ipc-also">
              <span className="small-muted">Also send a short note with the link:</span>
              {chan.connected.WhatsApp && <label><input type="checkbox" checked={alsoWa} onChange={(e) => setAlsoWa(e.target.checked)} /> WhatsApp</label>}
              {chan.connected.SMS && <label><input type="checkbox" checked={alsoSms} onChange={(e) => setAlsoSms(e.target.checked)} /> SMS</label>}
            </div>
          )}
          {copied && <div className="small-muted ipc-copied">{copied}</div>}
          {sendOut && (
            <div className="ivt-all" role="status">
              {sendOut.attempts.map((a) => (
                <div key={a.channel} className={`ivt-row ${a.status === 'sent' || a.status === 'sending' ? 'green' : (a.status === 'already' ? 'blue' : 'orange')}`}>
                  <b>{a.channel === 'Email' ? 'Mail' : a.channel}</b>
                  <span>{a.status === 'sent' ? `Sent${a.sandbox ? ' (test copy: nothing really left)' : ''}` : a.status === 'sending' ? 'On its way' : a.status === 'already' ? a.reason : `Not sent: ${a.reason || a.status}`}</span>
                  {a.status === 'already' && <button type="button" className="btn btn-sm" onClick={() => send(true)}>Send again</button>}
                </div>
              ))}
            </div>
          )}
          {show && (
            <div className="ipc-preview">
              <div className="small-muted">Subject: {data.candidate.subject}</div>
              {data.candidate.groups.map((g) => (
                <div key={g.key}><b>{g.title}</b><ol>{g.questions.map((q, i) => <li key={i}>{q}</li>)}</ol></div>
              ))}
              <div className="small-muted">The client&apos;s name, the pay and internal notes are never in it.</div>
            </div>
          )}
        </>
      )}

      {data.shares.length > 0 && (
        <section className="ipc-group ipc-log">
          <h4>Shared with the candidate</h4>
          <ul>
            {data.shares.map((s, i) => (
              <li key={i}>
                <b>{s.channel === 'Email' ? 'Mail' : s.channel}</b> · {s.status === 'sent' ? 'Sent' : s.status === 'sending' ? 'On its way' : s.status === 'link' ? 'Link copied' : 'Not sent'} · {when(s.at)}{s.byName ? ` · ${s.byName}` : ''}
                {s.status === 'failed' && s.reason ? ` · ${s.reason}` : ''}{!s.sameAsNow && s.status !== 'failed' ? ' · older version' : ''}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// A small button that opens the card in a window (used on the AI interviews list).
export function InterviewPrepButton({ applicationId, type = '', label = 'Preparation', className = 'btn btn-sm' }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>{label}</button>
      {open && (
        <Modal title="Interview preparation" onClose={() => setOpen(false)} wide footer={<button type="button" className="btn" onClick={() => setOpen(false)}>Close</button>}>
          <InterviewPrepCard applicationId={applicationId} type={type} />
        </Modal>
      )}
    </>
  );
}

// The "Interview prep" card for a screen (interview detail, candidate profile): collapsed until opened, so
// the page stays calm and the questions (and the first AI write) load only when asked.
export function InterviewPrepSection({ applicationId, type = '', title = 'Interview prep', startOpen = false }) {
  const [open, setOpen] = useState(startOpen);
  return (
    <div className="ipc-section">
      <button type="button" className="ipc-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <b>{title}</b>
        <span className="small-muted">{open ? 'Hide' : 'Questions to prepare, from the job description'}</span>
      </button>
      {open && <InterviewPrepCard applicationId={applicationId} type={type} compact />}
    </div>
  );
}

// ---- the booking window, with the preparation line -------------------------------------------------------------
// Used instead of <InterviewTell> after a booking / move. The line is hidden for a login that cannot send (BDE ...),
// when the questions were already sent for this version, and after a cancel.
export function InterviewTellWithPrep(props) {
  const { applicationId, kind = 'scheduled' } = props;
  const [info, setInfo] = useState(null); // { data, chan }
  const [on, setOn] = useState(true);
  const [edit, setEdit] = useState(false);
  const [state, setState] = useState(''); // '' | 'sending' | 'sent' | 'failed'
  const [msg, setMsg] = useState('');
  const tried = useRef(false);
  const live = kind !== 'cancelled';

  const load = useCallback(async () => {
    try {
      const r = await api.get(`/ats/interviews/${applicationId}/prep`);
      if (!r.data.canSend) { setInfo({ hide: true }); return; }
      const c = await api.get(`/ats/interviews/${applicationId}/prep/channels`, { params: { type: r.data.type } }).catch(() => ({ data: null }));
      setInfo({ data: r.data, chan: c.data });
    } catch { setInfo({ hide: true }); }
  }, [applicationId]);
  useEffect(() => { if (live) load(); }, [live, load]);

  const data = info && info.data;
  const mail = info && info.chan && info.chan.email;
  const already = !!(data && data.sentThisVersion);
  const canTry = !!(data && mail && mail.state === 'send' && !already);

  async function beforeDone(viaDoneButton) {
    if (!viaDoneButton || !live || !canTry || !on || tried.current) return false;
    tried.current = true;
    setState('sending'); setMsg('');
    try {
      const r = await api.post(`/ats/interviews/${applicationId}/prep/send`, { type: data.type, channels: ['Email'] });
      const a = r.data.attempts[0] || {};
      if (['sent', 'sending'].includes(a.status)) { setState('sent'); setMsg(`Preparation questions ${a.status === 'sent' ? 'sent' : 'on their way'} by Mail${a.sandbox ? ' (test copy: nothing really left)' : ''}.`); return false; }
      if (a.status === 'already') { setState('sent'); return false; }
      setState('failed'); setMsg(`Not sent: ${a.reason || 'the mail could not go'}. Press Done again to close without it.`); return true; // stay open once
    } catch (e) {
      setState('failed'); setMsg(`Not sent: ${errText(e, 'please try again')}. Press Done again to close without it.`); return true;
    }
  }

  let line = null;
  if (live && info && !info.hide && data) {
    const first = String(data.candidateName || '').replace(/^ZZTEST\S*\s*/i, '').split(/\s+/)[0] || 'the candidate';
    line = (
      <div className={`ipc-opt${state === 'failed' ? ' is-bad' : ''}`}>
        <label className="ipc-opt-row">
          <input type="checkbox" checked={on && canTry} disabled={!canTry || state === 'sending' || state === 'sent'} onChange={(e) => setOn(e.target.checked)} />
          <span><b>Send preparation questions to {first}</b> <small>({data.pack.groups.filter((g) => g.key !== 'ask').reduce((n, g) => n + g.questions.length, 0)} likely questions for this {TYPE_WORD[data.type].toLowerCase()} · {data.pack.sourceLabel.toLowerCase()})</small></span>
        </label>
        <div className="ipc-opt-sub">
          {state === 'sent' && <span className="ipc-ok">{msg || 'Sent.'}</span>}
          {state === 'sending' && <span>Sending…</span>}
          {state === 'failed' && <span className="ipc-bad">{msg}</span>}
          {!state && already && <span>Already sent for this interview ({data.shares.find((s) => s.sameAsNow && ['sent', 'sending'].includes(s.status)) ? when(data.shares.find((s) => s.sameAsNow && ['sent', 'sending'].includes(s.status)).at) : 'earlier'}).</span>}
          {!state && !already && canTry && <span>Goes by Mail when you press Done.</span>}
          {!state && !already && !canTry && <span>{mail ? `Mail: ${mail.reason || 'cannot be sent'}.` : 'Checking the mail…'} You can copy the page link from the preview.</span>}
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEdit(true)}>Preview / edit</button>
        </div>
        {edit && (
          <Modal title="Interview preparation" onClose={() => { setEdit(false); load(); }} wide footer={<button type="button" className="btn" onClick={() => { setEdit(false); load(); }}>Close</button>}>
            <InterviewPrepCard applicationId={applicationId} type={data.type} />
          </Modal>
        )}
      </div>
    );
  }

  return <InterviewTell {...props} extra={<>{props.extra}{line}</>} beforeDone={beforeDone} />;
}

export default InterviewPrepCard;
