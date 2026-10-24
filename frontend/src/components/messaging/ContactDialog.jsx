import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import { Modal } from '../proto.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import ChannelStrip from './ChannelStrip.jsx';
import { useContactRule } from './useMayMessage.js';
import {
  smsInfo, CHANNEL_ICON, canManageTemplates, useTokens, useUsable, useChannels, purposesFor, templateFor,
} from './msgKit.js';
import { ProviderLine, StatusTicks } from '../comm/commKit.jsx';
import { useWaSender } from './WaSender.jsx';
import './messaging.css';
import Combo from '../Combo.jsx';

// ---------------------------------------------------------------------------
// ONE WINDOW FOR EVERY WAY OF REACHING ONE PERSON — Call, Mail, WhatsApp, SMS.
//
// It always opens (no button is ever dead), always shows the ready-made
// message filled with that person's real details, lets you change the words,
// and then offers what is really possible RIGHT NOW:
//
//   Mail      account connected -> "Send mail" (Sent / Failed, with the reason)
//             not connected     -> "Open in my mail app" + "Copy message"
//   WhatsApp  Business API ready -> "Send WhatsApp" (the approved wording)
//             otherwise          -> "Open in WhatsApp" (wa.me, text filled) + "Copy"
//   SMS       account connected -> "Send SMS"
//             otherwise         -> "Copy message"; "Mark as sent" stays off with the
//                                  reason, because we cannot know it was sent
//   Call      the call script, the number big, "Call now" (tel:), then
//             "Save the call" (how it went + a note + the next follow-up)
//
// Every real send, and every time the person opens their own app, is logged on
// the person's history. Nothing here says "Sent" unless the server did.
// ---------------------------------------------------------------------------

const TITLE = { Email: 'Mail', SMS: 'SMS', WhatsApp: 'WhatsApp', Call: 'Call' };
const intl = (raw) => {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10) return `91${d}`;
  if (d.length === 11 && d.startsWith('0')) return `91${d.slice(1)}`;
  return d;
};
const copyText = async (text) => {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    try {
      const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select();
      const ok = document.execCommand('copy'); t.remove(); return ok;
    } catch { return false; }
  }
};
const ONE = { candidates: 'candidate', clients: 'client', employees: 'employee' };

export default function ContactDialog({
  channel: fixed, audience = 'candidates', personId, name, email, phone, applicationId, requirementId, purposeLabel, onClose, onLogged,
}) {
  const { user } = useAuth() || {};
  // What the SERVER says this login may do for this kind of person (Role Catalog: Contact (Mail / WhatsApp / SMS / Call)).
  // masked = it may not SEE the number: the server fills in and sends, the screen shows a hint, calls go through TeamLink.
  const rule = useContactRule(audience);
  const masked = rule.masked;
  const usable = useUsable(audience);
  const status = useChannels();
  const tokenInfo = useTokens();
  const [ch, setCh] = useState(fixed || 'Email');
  const [purpose, setPurpose] = useState(null); // key; '' = my own words
  const [language, setLanguage] = useState('English');
  const [text, setText] = useState('');
  const [subject, setSubject] = useState('');
  const [touched, setTouched] = useState(false);
  const [pv, setPv] = useState(null);
  const [pvErr, setPvErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [jobId, setJobId] = useState(null);
  const [note, setNote] = useState('');
  const [logged, setLogged] = useState('');
  const [copied, setCopied] = useState(false);
  const [attach, setAttach] = useState({ resume: false, offer: false }); // WhatsApp: send the resume / offer letter file with the message
  // WhatsApp: which company number the message leaves from (only the numbers the Admin gave this login; none = no sending)
  const wa = useWaSender(ch === 'WhatsApp', pv && pv.waNumber);
  // call
  const [script, setScript] = useState(null);
  const [vocab, setVocab] = useState(null);
  const [outcome, setOutcome] = useState('');
  const [callNote, setCallNote] = useState('');
  const [nextDate, setNextDate] = useState('');
  const [dialed, setDialed] = useState(false);
  // Call through TeamLink (Exotel click-to-call): your own phone rings first, then the person.
  const [gw, setGw] = useState(null);
  const [gwNote, setGwNote] = useState(null); // { ok, text }
  const [gwBusy, setGwBusy] = useState(false);
  useEffect(() => { api.get('/messaging/channels').then((r) => setGw(r.data.call || null)).catch(() => setGw(null)); }, []);
  async function callThrough() {
    setGwBusy(true); setGwNote(null);
    try {
      const r = await api.post('/messaging/call', { audience, id: personId, applicationId: applicationId || undefined });
      setDialed(true);
      setGwNote({ ok: true, text: r.data.message + (r.data.sandbox ? ' (Test copy of TeamLink: no real call is made.)' : '') });
    } catch (e) { setGwNote({ ok: false, text: e.response?.data?.error || 'The call could not be started.' }); } finally { setGwBusy(false); }
  }
  const [asked, setAsked] = useState(null);
  async function askColleague(channel) {
    try {
      const r = await api.post('/conversations/request-contact', { audience, id: personId, channel, applicationId: applicationId || undefined });
      setAsked({ ok: true, text: r.data.message });
      if (onLogged) onLogged({ channel });
    } catch (e) { setAsked({ ok: false, text: e.response?.data?.error || 'Could not ask.' }); }
  }
  const [saved, setSaved] = useState(false);
  const noRetry = useRef(false);
  const [tick, setTick] = useState(0); // a failed preparation tries again by itself (the server may be restarting)
  const tries = useRef(0);

  const isCall = ch === 'Call';
  const purposes = useMemo(() => {
    const list = purposesFor(usable, [ch]);
    return rule.purposes ? list.filter((p) => rule.purposes.includes(p.key)) : list; // Accounts: payment reminders only
  }, [usable, ch, rule.purposes]);
  const cur = purposes.find((p) => p.key === purpose);
  const langs = cur ? [...cur.languages] : ['English'];
  const tpl = purpose ? templateFor(usable, purpose, ch, language) : null;

  // pick the first purpose (or the one named by the caller) for this channel
  const [picked, setPicked] = useState(false); // the person chose a template themselves
  useEffect(() => {
    if (!usable) return;
    const byLabel = purposeLabel && purposes.find((p) => p.label.toLowerCase() === String(purposeLabel).toLowerCase());
    const first1 = byLabel ? byLabel.key : (purposes[0] ? purposes[0].key : '');
    if (!picked) { if (purpose !== first1) setPurpose(first1); } else if (purpose && !purposes.some((p) => p.key === purpose)) setPurpose(first1);
  }, [usable, ch, purposes, picked]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (cur && !cur.languages.has(language)) setLanguage('English'); }, [purpose, ch]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setTouched(false); setResult(null); setLogged(''); setCopied(false); }, [purpose, ch, language]);
  useEffect(() => { if (isCall && !vocab) api.get('/followups/statuses').then((r) => setVocab(r.data)).catch(() => setVocab({ callResults: ['Answered', 'Not Answered', 'Busy', 'Call Back'] })); }, [isCall]); // eslint-disable-line react-hooks/exhaustive-deps

  // The message with this person's real details (and whether it can really go)
  useEffect(() => {
    if (purpose === null || !usable || isCall) return undefined;
    const t = setTimeout(() => {
      setPvErr('');
      const own = purpose === '' || touched;
      api.post('/messaging/preview', {
        audience, ids: [personId], channels: [ch], kind: 'individual', purposeKey: purpose || undefined, language, applicationId, requirementId, purpose: purpose === '' ? 'Message' : undefined, waNumberId: ch === 'WhatsApp' ? wa.numberId : undefined,
        perChannel: { [ch]: { templateId: tpl ? tpl.id : undefined, ...(own ? { subject, body: text } : {}) } },
      }).then((r) => {
        tries.current = 0;
        setPv(r.data);
        const f = r.data.first;
        if (f && !touched && purpose !== '') { setText(f.text || ''); setSubject(f.subject || ''); }
      }).catch((e) => {
        setPv(null); setPvErr(e.response?.data?.error || 'Could not prepare the message. Trying again…');
        if ((!e.response || e.response.status >= 500) && tries.current < 5) { tries.current += 1; setTimeout(() => setTick((x) => x + 1), 2500); }
      });
    }, 250);
    return () => clearTimeout(t);
  }, [audience, personId, ch, purpose, language, tpl && tpl.id, touched, touched ? text : '', touched ? subject : '', usable, isCall, tick, wa.numberId]); // eslint-disable-line react-hooks/exhaustive-deps

  // The call script
  useEffect(() => {
    if (!isCall || purpose === null || !usable) return;
    if (!purpose) { setScript({ text: '', phone }); return; }
    api.post('/messaging/script', { audience, id: personId, purposeKey: purpose, language, applicationId, requirementId })
      .then((r) => setScript(r.data)).catch(() => setScript({ text: '', phone }));
  }, [isCall, purpose, language, usable]); // eslint-disable-line react-hooks/exhaustive-deps

  const first = pv && pv.first;
  const sendable = !!(first && first.status === 'queued');
  const locked = !!(first && first.locked && sendable);
  const address = ch === 'Email' ? email : phone;
  const hasAddr = address === undefined ? true : !!address;
  const why = first && first.status !== 'queued' ? first.reason : null;
  // details that are not on this profile stay as {{placeholders}} in the text: they must be replaced by hand
  const leftoverAll = [...new Set((String(text).match(/\{\{\s*\w+\s*\}\}/g) || []).map((m) => m.replace(/[{}\s]/g, '')))];
  const labelOf = (k) => { const t = tokenInfo && tokenInfo.tokens.find((x) => x.key === k || (x.aliases || []).includes(k)); return t ? t.label : k; };
  // The agreement link is not "filled by hand": it is made with one button (below).
  const linkMissing = audience === 'clients' && !isCall && (leftoverAll.includes('agreementLink') || !!(first && (first.missing || []).includes('agreementLink')));
  const leftover = leftoverAll.filter((k) => k !== 'agreementLink');
  const needsHand = leftover.length > 0 || linkMissing;
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkErr, setLinkErr] = useState('');
  async function makeLink() {
    setLinkBusy(true); setLinkErr('');
    try {
      const r = await api.post(`/agreement/${personId}/link`, {});
      const url = r.data && r.data.url;
      // text you already changed keeps your words: only the placeholder is filled
      if (url && touched) setText((t) => String(t).replace(/\{\{\s*agreementLink\s*\}\}/g, url));
      setTick((x) => x + 1);
    } catch (e) { setLinkErr(e.response?.data?.error || 'The link could not be made. Please try again.'); } finally { setLinkBusy(false); }
  }

  // ---- logging an open-in-own-app contact --------------------------------------
  async function logDevice() {
    try {
      if (audience === 'candidates') {
        await api.post('/followups/quick-log', { candidateId: personId, applicationId: applicationId || null, channel: ch, purpose: (cur && cur.label) || 'Message' });
      } else {
        await api.post('/messaging/device-log', { audience, id: personId, channel: ch, purpose: (cur && cur.label) || 'Message' });
      }
      setLogged(`Logged on ${name}'s history.`);
      if (onLogged) onLogged({ channel: ch });
    } catch (e) { setLogged(e.response?.data?.error ? `Could not log it: ${e.response.data.error}` : 'Could not log it.'); }
  }
  // These open another app, so they run INSIDE the click, before anything is awaited.
  function openWhatsApp() {
    window.open(`https://wa.me/${intl(phone)}?text=${encodeURIComponent(text || '')}`, '_blank', 'noopener');
    logDevice();
  }
  function openMail() {
    window.location.href = `mailto:${email}?subject=${encodeURIComponent(subject || '')}&body=${encodeURIComponent(text || '')}`;
    logDevice();
  }
  async function copy() {
    const ok = await copyText(ch === 'Email' && subject ? `${subject}\n\n${text}` : text);
    setCopied(ok);
  }

  async function send() {
    setBusy(true); setResult(null);
    try {
      const own = purpose === '' || touched;
      const r = await api.post('/messaging/send', {
        audience, id: personId, channel: ch, purposeKey: purpose || undefined, language, applicationId, requirementId, purpose: purpose === '' ? 'Message' : undefined, waNumberId: ch === 'WhatsApp' ? wa.numberId : undefined,
        perChannel: { [ch]: { templateId: tpl ? tpl.id : undefined, ...(own ? { subject, body: text } : {}) } },
        attachments: ch === 'WhatsApp' && audience === 'candidates' && !masked ? [attach.resume && { type: 'resume' }, attach.offer && applicationId && { type: 'offer', applicationId }].filter(Boolean) : undefined,
      });
      setJobId(r.data.jobId); setResult(r.data);
      if (onLogged) onLogged({ channel: ch });
    } catch (e) { setResult({ error: e.response?.data?.error || 'The message could not be sent.' }); } finally { setBusy(false); }
  }
  async function retry() {
    if (!jobId) return;
    setBusy(true);
    try {
      await api.post(`/messaging/bulk/${jobId}/retry-failed`, {});
      for (let i = 0; i < 40; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((res) => { setTimeout(res, 500); });
        // eslint-disable-next-line no-await-in-loop
        const j = await api.get(`/messaging/bulk/${jobId}`);
        if (j.data.status === 'done') { const row = j.data.recipients[0]; setResult({ jobId, result: { status: row.status, reason: row.reason, address: row.address, sandbox: row.sandbox, provider: row.provider, via: row.via, queued: row.queued, providerRef: row.providerRef }, finished: true }); break; }
      }
    } catch (e) { setResult({ error: e.response?.data?.error || 'Could not try again.' }); } finally { setBusy(false); }
  }

  async function saveCall() {
    setBusy(true); setResult(null);
    try {
      if (audience === 'candidates') {
        await api.post(`/candidates/${personId}/contact`, { method: 'Call', purpose: (cur && cur.label) || 'Call', callResult: outcome, notes: callNote, applicationId: applicationId || undefined });
        if (nextDate && applicationId) await api.post('/followups', { applicationId, dueDate: nextDate, contactMode: 'Call', notes: callNote || undefined }).catch(() => {});
      } else {
        await api.post('/messaging/device-log', { audience, id: personId, channel: 'Call', purpose: `Call: ${outcome}${callNote ? ` - ${callNote}` : ''}` });
      }
      setSaved(true);
      if (onLogged) onLogged({ channel: 'Call' });
    } catch (e) { setResult({ error: e.response?.data?.error || 'The call could not be saved.' }); } finally { setBusy(false); }
  }
  function closeCall() {
    // eslint-disable-next-line no-alert
    if (isCall && dialed && !saved && !window.confirm('You pressed Call now but have not saved the call. Close without saving it?')) return;
    onClose();
  }

  const showChooser = !fixed;
  const callResults = (vocab && vocab.callResults) || [];
  const header = `${TITLE[ch]} ${name}`;
  const manage = canManageTemplates(user) ? <Link className="small-muted" to="/admin/message-templates" style={{ marginLeft: 8 }}>Edit the templates</Link> : null;

  // A role the Role Catalog / the rules do not let contact this kind of person: say why, in plain words (no dead buttons).
  if (rule.loaded && !rule.allowed) {
    return (
      <Modal title={header} onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>Close</button>}>
        <div className="msg-box orange"><b>You cannot contact {name} from here.</b> {rule.reason || 'Your role does not follow up this kind of person.'}</div>
      </Modal>
    );
  }

  // ================== CALL ====================================================
  if (isCall) {
    const num = masked ? '' : (phone || (script && script.phone) || '');
    const hint = (script && script.phoneHint) || '';
    return (
      <Modal
        title={header}
        onClose={closeCall}
        footer={saved ? <button type="button" className="btn btn-primary" onClick={onClose}>Done</button> : (
          <>
            <button type="button" className="btn" onClick={closeCall}>Close</button>
            {(!masked || dialed) && <button type="button" className="btn btn-primary" disabled={busy || !outcome} onClick={saveCall}>{busy ? 'Saving…' : 'Save the call'}</button>}
          </>
        )}
      >
        {showChooser && <ChannelButtons ch={ch} setCh={setCh} status={status} email={email} phone={phone} />}
        <ChannelStrip showHelp={false} />
        {masked && <div className="msg-box blue">You reach {name} through TeamLink. Their number{hint ? ' (' + hint + ')' : ''} stays hidden.</div>}
        {saved ? (
          <div className="msg-box green"><b>Saved.</b> The call ({outcome}) is on {name}&apos;s history{nextDate ? ` and the next follow-up is ${nextDate}` : ''}.</div>
        ) : (
          <>
            <div className="field" style={{ textAlign: 'center' }}>
              {masked ? (
                <>
                  <div style={{ fontSize: 22, fontWeight: 700 }}>{hint || 'Number hidden'}</div>
                  {gw && gw.configured ? (
                    <>
                      <button type="button" className="btn btn-primary" style={{ marginTop: 6, fontSize: 15 }} disabled={gwBusy} onClick={callThrough}>{gwBusy ? 'Starting…' : '📞 Call through TeamLink'}</button>
                      <div className="small-muted" style={{ marginTop: 4 }}>Your own phone rings first. Pick up, and TeamLink connects {name}. The number is never shown to you.</div>
                      {gwNote && <div className={`msg-box ${gwNote.ok ? 'green' : 'red'}`} style={{ marginTop: 6 }}>{gwNote.text}</div>}
                    </>
                  ) : (
                    <>
                      <div className="msg-box orange" style={{ textAlign: 'left' }}>Calling through TeamLink is not connected yet, and your role does not see the number. Ask the recruiter to call {name}: they get your request at once.</div>
                      <button type="button" className="btn btn-primary" onClick={() => askColleague('Call')} disabled={!!(asked && asked.ok)}>Ask the recruiter to call</button>
                      {asked && <div className={`msg-box ${asked.ok ? 'green' : 'red'}`} style={{ marginTop: 6, textAlign: 'left' }}>{asked.text}</div>}
                    </>
                  )}
                </>
              ) : num ? (
                <>
                  <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: .5 }}>{num}</div>
                  {gw && gw.configured && (
                    <>
                      <button type="button" className="btn btn-primary" style={{ marginTop: 6, fontSize: 15 }} disabled={gwBusy} onClick={callThrough}>{gwBusy ? 'Starting…' : '📞 Call through TeamLink'}</button>
                      <div className="small-muted" style={{ marginTop: 4 }}>Your own phone rings first. Pick up, and TeamLink connects {name}. The result is saved on the history.{gw.recording ? ' This call is recorded: tell them.' : ''}</div>
                      {gwNote && <div className={`msg-box ${gwNote.ok ? 'green' : 'red'}`} style={{ marginTop: 6 }}>{gwNote.text}</div>}
                    </>
                  )}
                  <a className={`btn${gw && gw.configured ? '' : ' btn-primary'}`} style={{ display: 'inline-block', marginTop: 6, fontSize: gw && gw.configured ? 13 : 15 }} href={`tel:+${intl(num)}`} onClick={() => setDialed(true)}>{gw && gw.configured ? 'Or call from my own phone' : '📞 Call now'}</a>
                  <div className="small-muted" style={{ marginTop: 4 }}>{gw && gw.configured ? 'This opens the dialler of your own phone or computer.' : 'This opens the dialler on your phone or computer.'} Then come back and save how it went.</div>
                </>
              ) : <div className="msg-box orange">There is no phone number on this profile yet, so we cannot dial. Add the number first, or tell us how the call went below if you reached them another way.</div>}
            </div>
            <div className="field">
              <label>What to say{manage}</label>
              <Combo value={purpose === null ? '' : (purpose === '' ? '__own' : purpose)} onChange={(e) => { setPicked(true); setPurpose(e.target.value === '__own' ? '' : e.target.value); }}>
                {purposes.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
                <option value="__own">No script</option>
              </Combo>
              {script && script.text && <div className="msg-preview" style={{ marginTop: 6 }}>{script.text}</div>}
            </div>
            <div className="field">
              <label>How did the call go?</label>
              <div className="msg-filter">{callResults.map((o) => <button key={o} type="button" className={`msg-chip${outcome === o ? ' on' : ''}`} onClick={() => setOutcome(o)}>{o}</button>)}</div>
            </div>
            <div className="field"><label>Note</label><textarea rows="3" className="msg-textarea" value={callNote} onChange={(e) => setCallNote(e.target.value)} /></div>
            {audience === 'candidates' && applicationId && (
              <div className="field"><label>Next follow-up (optional)</label><input type="date" value={nextDate} onChange={(e) => setNextDate(e.target.value)} /></div>
            )}
            {result && result.error && <div className="msg-box red">{result.error}</div>}
          </>
        )}
      </Modal>
    );
  }

  // ================== MAIL / WHATSAPP / SMS ====================================
  const r = result && result.result;
  let box = null;
  const word = ch === 'Email' ? 'Mail' : ch;
  const when = r && r.at ? ` at ${new Date(r.at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}` : '';
  if (result) {
    if (result.error) box = <div className="msg-box red"><b>{word} status: Not sent.</b> {result.error}</div>;
    else if (!r) box = <div className="msg-box blue"><b>{word} status: Waiting.</b> Still sending. You can close this: it will finish by itself.</div>;
    else if (r.status === 'sent') {
      const how = r.via ? ` via ${r.via}` : '';
      box = (
        <div className={`msg-box ${r.queued ? 'blue' : 'green'}`}>
          <b>{word} status: {r.queued ? 'Queued' : 'Sent'}</b>{how} to {name} ({r.address}){when}.
          {r.queued && <div>{r.provider === 'whatsapp.qr' ? 'It waits in line: this number sends one message at a time with a pause, so it can take a few minutes.' : 'The phone has it and will send it in a moment.'}</div>}
          {r.tried && <div>Another way was tried first: {r.tried}</div>}
          {r.sandbox && <div>This is the test copy of TeamLink: nothing was really sent.</div>}
          {r.providerRef && ch !== 'Email' && <StatusTicks providerRef={r.providerRef} channel={ch} initial={r.queued ? 'queued' : 'sent'} />}
          {ch === 'WhatsApp' && (
            <div style={{ marginTop: 6 }}>
              Their reply comes in the same chat as this message (Follow-ups → WhatsApp chats), sent and received together.{' '}
              <Link className="btn btn-sm" to={`/ats/followups?sub=chats&chat=${{ candidates: 'CANDIDATE', clients: 'CLIENT', employees: 'EMPLOYEE' }[audience] || 'CANDIDATE'}:${encodeURIComponent(personId)}`} onClick={onClose}>Open this conversation</Link>
            </div>
          )}
        </div>
      );
    }
    else if (r.status === 'failed') box = <div className="msg-box red"><b>{word} status: Failed{when}.</b> {r.reason} Press Try again.</div>;
    else if (r.status === 'blocked') box = <div className="msg-box red"><b>{word} status: Blocked.</b> {r.reason}</div>;
    else box = <div className="msg-box orange"><b>{word} status: Not sent.</b> {r.reason}</div>;
  }
  const channelReady = !!(status && status[ch] && status[ch].configured);
  const sendWord = { Email: 'Send mail', SMS: 'Send SMS', WhatsApp: 'Send WhatsApp' }[ch];
  const sms = ch === 'SMS' ? smsInfo(text) : null;
  const setupLine = {
    Email: 'Company mail is not connected yet (Administration → Integrations → Email). Until then, open the message in your own mail app or copy it.',
    WhatsApp: 'WhatsApp Business is not connected yet (Administration → Integrations → WhatsApp). Until then, open it in your own WhatsApp: the message is filled in for you.',
    SMS: 'SMS sending needs an SMS account (Administration → Integrations). Until then, copy the message and send it from your phone.',
  }[ch];

  return (
    <Modal
      title={header}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>{result && !result.error ? 'Close' : 'Cancel'}</button>
          {r && r.status === 'failed' && <button type="button" className="btn btn-primary" disabled={busy} onClick={retry}>{busy ? 'Trying…' : 'Try again'}</button>}
          {!result && (sendable || !!(first && first.missing && first.missing.length > 0 && !first.reason.startsWith('No ') && first.status === 'skipped' && channelReady)) && (
            <button type="button" className="btn btn-primary" title={needsHand ? 'Replace the {{details}} in the message first' : ''} disabled={busy || !text.trim() || needsHand || (!sendable && !touched) || (ch === 'WhatsApp' && !wa.canSend)} onClick={send}>{busy ? 'Sending…' : sendWord}</button>
          )}
          {!masked && !result && !sendable && !(channelReady && first && first.status === 'skipped') && ch === 'WhatsApp' && wa.canSend && <button type="button" className="btn btn-primary" disabled={!phone || !text.trim() || needsHand} onClick={openWhatsApp}>Open in WhatsApp</button>}
          {!masked && !result && !sendable && !(channelReady && first && first.status === 'skipped') && ch === 'Email' && <button type="button" className="btn btn-primary" disabled={!email || !text.trim() || needsHand} onClick={openMail}>Open in my mail app</button>}
          {!masked && !result && !sendable && !(channelReady && first && first.status === 'skipped') && ch === 'SMS' && <button type="button" className="btn btn-primary" disabled={!text.trim()} onClick={copy}>{copied ? 'Copied' : 'Copy message'}</button>}
          {masked && !result && !sendable && !(channelReady && first && first.status === 'skipped') && <button type="button" className="btn btn-primary" disabled={!!(asked && asked.ok)} onClick={() => askColleague(ch)}>Ask the recruiter to send it</button>}
        </>
      )}
    >
      {showChooser && <ChannelButtons ch={ch} setCh={setCh} status={status} email={email} phone={phone} />}
      <ChannelStrip showHelp={false} />
      {ch === 'WhatsApp' && !result && wa.node}
      {(ch === 'WhatsApp' || ch === 'SMS') && !result && !(ch === 'WhatsApp' && wa.active) && <ProviderLine channel={ch} />}
      <div className="small-muted" style={{ marginBottom: 8 }}>
        To: {masked ? ((first && first.address) || 'hidden') : (address === undefined ? (first && first.address) : (address || (ch === 'Email' ? 'no email address on this profile' : 'no phone number on this profile')))}
        {masked && ' (the number stays hidden: TeamLink sends it for you)'}
      </div>

      {!result && (
        <>
      <div className="field">
        <label htmlFor="cd-tpl">Template{manage}</label>
        <Combo id="cd-tpl" value={purpose === null ? '' : (purpose === '' ? '__own' : purpose)} onChange={(e) => { setPicked(true); setPurpose(e.target.value === '__own' ? '' : e.target.value); }}>
          {purposes.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          <option value="__own">Write my own message</option>
        </Combo>
      </div>
      {langs.length > 1 && purpose && (
        <div className="field"><label>Language</label>
          <div className="msg-filter">{langs.map((l) => <button key={l} type="button" className={`msg-chip${language === l ? ' on' : ''}`} onClick={() => setLanguage(l)}>{l}</button>)}</div>
        </div>
      )}

        </>
      )}

      {!result && (
        <>
          {ch === 'Email' && (
            <div className="field"><label htmlFor="cd-sub">Subject</label>
              <input id="cd-sub" value={subject} maxLength={200} disabled={locked} onChange={(e) => { setSubject(e.target.value); setTouched(true); }} />
            </div>
          )}
          <div className="field">
            <label htmlFor="cd-body">Message (the details are filled in; you can change the words)</label>
            <textarea id="cd-body" className="msg-textarea" rows="7" value={text} readOnly={locked}
              placeholder={purpose === '' ? 'Type your message here.' : ''} onChange={(e) => { setText(e.target.value); setTouched(true); }} />
            {sms && <div className={`msg-count${sms.segments > 2 ? ' warn' : ''}`}>{sms.chars} letters = {sms.segments} SMS part(s){sms.unicode ? ' (Telugu / Hindi use more space)' : ''}</div>}
            {locked && <div className="small-muted">{ch === 'WhatsApp' ? 'WhatsApp sends the wording Meta approved, so it cannot be changed here.' : 'This SMS is a registered template, so its words cannot be changed here.'}</div>}
            {touched && tpl && !locked && <button type="button" className="btn btn-sm" style={{ marginTop: 6 }} onClick={() => setTouched(false)}>Back to the template words</button>}
          </div>
          {ch === 'WhatsApp' && audience === 'candidates' && !masked && sendable && (
            <div className="cm-attach">
              <label><input type="checkbox" checked={attach.resume} onChange={(e) => setAttach({ ...attach, resume: e.target.checked })} /> Send the resume file with this message</label>
              {applicationId && <label><input type="checkbox" checked={attach.offer} onChange={(e) => setAttach({ ...attach, offer: e.target.checked })} /> Send the offer letter file</label>}
            </div>
          )}
        </>
      )}

      {pvErr && <div className="msg-box red">{pvErr}</div>}
      {box}
      {!result && linkMissing && (
        <div className="msg-box orange" role="alert">
          <b>The agreement link is not ready yet.</b> The message has a place for it, but this client has no working link. Make the link here: it is filled into the message by itself. Nothing is sent until you press Send mail.
          <div style={{ marginTop: 6 }}>
            <button type="button" className="btn btn-primary" disabled={linkBusy} onClick={makeLink}>{linkBusy ? 'Making the link…' : 'Create agreement link'}</button>
          </div>
          {linkErr && <div className="msg-box red" style={{ marginTop: 6 }}>{linkErr}</div>}
        </div>
      )}
      {!result && !sendable && first && !needsHand && first.status === 'skipped' && channelReady && !touched && (
        <div className="msg-box orange" role="alert"><b>Send is off for now.</b> {why || 'Something in the message is missing.'} Change the message or fix the detail, then you can send it.</div>
      )}
      {!result && first && first.warning && <div className="msg-box orange" role="status">{first.warning}</div>}
      {!result && leftover.length > 0 && (
        <div className="msg-box orange"><b>Not on this profile yet:</b> {leftover.map(labelOf).join(', ')}. Replace {leftover.map((k) => `{{${k}}}`).join(', ')} in the message by hand, then you can send it.</div>
      )}
      {!result && !sendable && first && !(first.missing && first.missing.length && channelReady && first.status === 'skipped') && (
        <div className="msg-box orange">
          {first.notSetUp ? setupLine : (<><b>{first.status === 'blocked' ? 'Cannot send from here.' : 'Cannot send yet.'}</b> {why}</>)}
          {ch === 'SMS' && <div style={{ marginTop: 4 }}>Mark as sent is off: we cannot know the message was sent from your phone.</div>}
        </div>
      )}
      {!result && !sendable && first && ch === 'SMS' && (
        <button type="button" className="btn btn-sm" disabled title="We cannot see your phone, so we cannot know it was sent. Send it from your phone after copying.">Mark as sent</button>
      )}
      {!result && !sendable && first && (ch !== 'SMS') && (
        <button type="button" className="btn btn-sm" disabled={!text.trim()} onClick={copy}>{copied ? 'Copied' : 'Copy message'}</button>
      )}
      {asked && ch !== 'Call' && <div className={`msg-box ${asked.ok ? 'green' : 'red'}`}>{asked.text}</div>}
      {copied && ch === 'SMS' && <div className="msg-box green">Copied. Paste it into your phone&apos;s messages.</div>}
      {logged && <div className="small-muted" style={{ marginTop: 6 }}>{logged}</div>}
      {result && !result.error && <div className="small-muted" style={{ marginTop: 6 }}>It is on {name}&apos;s history ({ONE[audience]}).</div>}
      <span style={{ display: 'none' }}>{noRetry.current ? '1' : ''}</span>
    </Modal>
  );
}

function ChannelButtons({ ch, setCh, status, email, phone }) {
  return (
    <div className="field">
      <label>How?</label>
      <div className="msg-chbtns">
        {['Call', 'Email', 'WhatsApp', 'SMS'].map((c) => {
          const st = status && status[c];
          const missing = c === 'Email' ? email === '' : phone === '';
          return (
            <button key={c} type="button" className={`msg-chbtn${ch === c ? ' on' : ''}`} onClick={() => { setCh(c); }}>
              {CHANNEL_ICON[c] || '📞'} {c === 'Email' ? 'Mail' : c === 'SMS' ? 'SMS' : c}
              <small>{missing ? (c === 'Email' ? 'No email on file' : 'No phone on file') : (c === 'Call' ? 'Script + dial' : (st ? (st.configured ? 'Sends from here' : 'Uses your own app') : ''))}</small>
            </button>
          );
        })}
      </div>
    </div>
  );
}
