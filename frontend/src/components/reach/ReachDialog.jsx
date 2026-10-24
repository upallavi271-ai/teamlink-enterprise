import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import Modal from './ReachModal.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import TokenPicker, { insertToken } from '../messaging/TokenPicker.jsx';
import {
  useTokens, smsInfo, canManageTemplates, useUsable, purposesFor, templateFor, Highlighted,
} from '../messaging/msgKit.js';
import ReachResult from './ReachResult.jsx';
import { ProviderLine } from '../comm/commKit.jsx';
import {
  REACH_MAX, countLine, CHANNEL_LABEL, CHANNEL_NOUN, waHref, smsHref, mailHref, copyText,
} from './reachKit.js';
import '../messaging/messaging.css';
import './reach.css';
import Combo from '../Combo.jsx';

// ---------------------------------------------------------------------------
// MESSAGE MANY CANDIDATES — Message (SMS) · WhatsApp · Email, one window.
//
//   1  "You selected 37: 31 can be messaged, 4 no consent, 2 no phone"  (checked by the server)
//   2  pick the template, change the words if allowed, see ONE person's real message
//      (their own name, job and dates filled in; never the client's name)
//   3a channel CONNECTED     -> confirm -> the ordinary queue (daily limits, de-dupe, quiet hours,
//                               consent) -> a result with a plain word per person
//   3b channel NOT connected -> the honest way: one person at a time, "Open WhatsApp" with the
//                               message already typed (or Copy). Logged as "Opened in your app",
//                               never as Sent.
// ---------------------------------------------------------------------------

const OPEN_WORD = { WhatsApp: 'Open WhatsApp', SMS: 'Open Messages', Email: 'Open my mail app' };
const hrefOf = (ch, p) => (ch === 'WhatsApp' ? waHref(p.phone, p.text) : ch === 'SMS' ? smsHref(p.phone, p.text) : mailHref(p.email || p.address, p.subject, p.text));

export default function ReachDialog({
  channel, items, onClose, onDone,
}) {
  const { user } = useAuth() || {};
  const ids = useMemo(() => [...new Set(items.map((x) => x.id))], [items]);
  const tokens = useTokens();
  const usable = useUsable('candidates');
  const [chk, setChk] = useState(null);
  const [err, setErr] = useState('');
  const [purpose, setPurpose] = useState(null); // key; '' = my own words
  const [language, setLanguage] = useState('English');
  const [edit, setEdit] = useState(null); // { subject, body } once the person changes the words
  const [cmp, setCmp] = useState(null);
  const [cmpErr, setCmpErr] = useState('');
  const [who, setWho] = useState(0); // which reachable person the preview shows
  const [stage, setStage] = useState('compose'); // compose | confirm | running | result | queue
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState(null);
  const [res, setRes] = useState(null);
  const bodyRef = useRef(null);

  const purposes = useMemo(() => purposesFor(usable, [channel]), [usable, channel]);
  const cur = purposes.find((p) => p.key === purpose);
  const langs = cur ? [...cur.languages] : ['English'];
  const tpl = purpose ? templateFor(usable, purpose, channel, language) : null;
  const locked = !!(tpl && tpl.locked);
  const writeOwn = purpose === '';

  useEffect(() => { if (usable && purpose === null && purposes.length) setPurpose(purposes[0].key); }, [usable, purposes]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setEdit(null); }, [purpose, language]);

  // 1) the check, at once (it needs no template)
  useEffect(() => {
    let on = true;
    api.post('/messaging/reach/check', { channel, ids }).then((r) => { if (on) setChk(r.data); }).catch((e) => { if (on) setErr(e.response?.data?.error || 'Could not check the list.'); });
    return () => { on = false; };
  }, [channel, ids]);

  // 2) the message for everybody, rebuilt when the words change
  const request = useMemo(() => ({
    channel, ids, purposeKey: purpose || undefined, language, purpose: writeOwn ? 'Message' : undefined,
    perChannel: { [channel]: { templateId: tpl ? tpl.id : undefined, ...(edit || writeOwn ? { subject: (edit || {}).subject || '', body: (edit || {}).body || '' } : {}) } },
  }), [channel, ids, purpose, language, tpl && tpl.id, edit, writeOwn]); // eslint-disable-line react-hooks/exhaustive-deps
  const ready = purpose !== null && (!writeOwn || (edit && edit.body && edit.body.trim()));
  useEffect(() => {
    if (!ready || stage !== 'compose') return undefined;
    const t = setTimeout(() => {
      setCmpErr('');
      api.post('/messaging/reach/compose', request).then((r) => { setCmp(r.data); }).catch((e) => { setCmp(null); setCmpErr(e.response?.data?.error || 'Could not prepare the message.'); });
    }, 350);
    return () => clearTimeout(t);
  }, [JSON.stringify(request), ready, stage]); // eslint-disable-line react-hooks/exhaustive-deps

  const connected = cmp ? cmp.connected : (chk ? chk.connected : null);
  const reach = cmp ? (connected ? cmp.counts.ok || 0 : cmp.canOpen) : (chk ? chk.canReach : 0);
  const counts = cmp ? cmp.counts : (chk ? chk.counts : {});
  const countsShown = { ...counts }; delete countsShown.ok;
  const people = cmp ? cmp.people : [];
  const preview = people.filter((p) => (connected ? p.code === 'ok' : p.canOpen))[who] || null;
  const reachable = people.filter((p) => (connected ? p.code === 'ok' : p.canOpen));
  const baseBody = edit ? edit.body : (tpl ? tpl.body : '');
  const baseSubject = edit ? edit.subject : (tpl ? tpl.subject : '');

  async function send() {
    setBusy(true); setErr('');
    try {
      const r = await api.post('/messaging/reach/send', { ...request, confirmPeople: reach });
      setJob(r.data); setStage('running');
    } catch (e) { setErr(e.response?.data?.error || 'The send could not be started.'); setStage('compose'); } finally { setBusy(false); }
  }
  useEffect(() => {
    if (stage !== 'running' || !job) return undefined;
    let on = true;
    const tick = async () => {
      try {
        const r = await api.get(`/messaging/reach/result/${job.id}`);
        if (!on) return;
        setRes(r.data);
        if (r.data.finished) { setStage('result'); if (onDone) onDone(); return; }
      } catch (e) { if (on) setErr(e.response?.data?.error || 'Could not read the progress.'); }
      if (on) setTimeout(tick, 1200);
    };
    tick();
    return () => { on = false; };
  }, [stage, job]); // eslint-disable-line react-hooks/exhaustive-deps

  const head = `${CHANNEL_LABEL[channel]} — ${ids.length} candidate${ids.length === 1 ? '' : 's'}`;
  const manage = canManageTemplates(user) ? <Link className="small-muted" to="/admin/message-templates" style={{ marginLeft: 8 }}>Edit the templates</Link> : null;

  if (stage === 'queue' && cmp) {
    return <OwnAppQueue channel={channel} cmp={cmp} purposeLabel={(cur && cur.label) || 'Message'} onClose={onClose} onDone={onDone} />;
  }

  if (stage === 'running' || stage === 'result') {
    const done = res ? res.people.filter((p) => !['queued', 'sending'].includes(p.status)).length : 0;
    return (
      <Modal
        wide
        title={stage === 'result' ? `${CHANNEL_LABEL[channel]} — done` : `Sending ${CHANNEL_NOUN[channel]}s…`}
        onClose={onClose}
        footer={<button type="button" className="btn btn-primary" onClick={onClose}>{stage === 'result' ? 'Done' : 'Close (sending goes on)'}</button>}
      >
        {stage === 'running' && (
          <div className="msg-box blue">Sending… {done} of {res ? res.people.length : reach} handled. You can close this: it finishes by itself and every message is saved on the candidate&apos;s history.</div>
        )}
        {res && stage === 'result' && (
          <>
            <div className="msg-box blue">You selected {res.selected}: {res.counts.sent || 0} sent{Object.keys(res.counts).filter((k) => k !== 'sent').length ? ' — the rest are below, with the reason for each' : ''}.</div>
            <ReachResult people={res.people} extra={res.outside ? [{ code: 'outside', word: 'Outside your access', tone: 'red', count: res.outside }] : []} />
            {Object.values(res.people).some((p) => p.status === 'sent' && p.sandbox) && <div className="small-muted">This is the test copy of TeamLink: nothing was really sent.</div>}
          </>
        )}
        {err && <div className="msg-box red">{err}</div>}
      </Modal>
    );
  }

  if (stage === 'confirm') {
    return (
      <Modal
        title={`Send to ${reach} candidate${reach === 1 ? '' : 's'}?`}
        onClose={onClose}
        footer={(
          <>
            <button type="button" className="btn" onClick={() => setStage('compose')}>No, go back</button>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={send}>{busy ? 'Starting…' : `Yes, send to ${reach}`}</button>
          </>
        )}
      >
        <div className="msg-box blue">{reach} by {CHANNEL_LABEL[channel]}. Once sent, a message cannot be taken back. You can stop the rest while it is going.</div>
        <div className="small-muted">{countLine(ids.length, reach, 'will get it', countsShown)}.</div>
        {err && <div className="msg-box red">{err}</div>}
      </Modal>
    );
  }

  const overMax = ids.length > REACH_MAX;
  const sms = channel === 'SMS' ? smsInfo(baseBody) : null;
  return (
    <Modal
      wide
      title={head}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          {connected === true && (
            <button type="button" className="btn btn-primary" disabled={!reach || overMax || !cmp} onClick={() => setStage('confirm')}>
              {reach ? `Next: send to ${reach}` : 'Nobody to send to'}
            </button>
          )}
          {connected === false && (
            <button type="button" className="btn btn-primary" disabled={!reach || overMax || !cmp} onClick={() => setStage('queue')}>
              {reach ? `Start: ${reach} chat${reach === 1 ? '' : 's'} one by one` : 'Nobody to message'}
            </button>
          )}
        </>
      )}
    >
      {(channel === 'WhatsApp' || channel === 'SMS') && <ProviderLine channel={channel} />}
      {overMax && <div className="msg-box red">You ticked {ids.length}. At most {REACH_MAX} at a time: narrow the list, or do it in batches.</div>}
      {err && <div className="msg-box red">{err}</div>}
      <div className="rch-count">{chk || cmp ? countLine(ids.length, reach, connected === false ? 'can be opened in your app' : 'can be messaged', countsShown) : 'Checking the list…'}</div>
      {Object.keys(countsShown).length > 0 && cmp && (
        <details className="msg-details" style={{ marginBottom: 8 }}>
          <summary>Who is left out, and why</summary>
          <ReachResult people={people.filter((p) => !(connected ? p.code === 'ok' : p.canOpen))} extra={cmp.outside ? [{ code: 'outside', word: 'Outside your access', tone: 'red', count: cmp.outside }] : []} />
        </details>
      )}
      {connected === false && (
        <div className="msg-box orange">
          <b>{CHANNEL_LABEL[channel]} is not connected to TeamLink yet</b>, so nothing can be sent for you. You will open each chat in your own {channel === 'WhatsApp' ? 'WhatsApp' : channel === 'SMS' ? 'messages app' : 'mail app'} with the message already typed, one person after another.
        </div>
      )}

      <div className="field">
        <label htmlFor="rch-tpl">Template{manage}</label>
        <Combo id="rch-tpl" value={purpose === null ? '' : (writeOwn ? '__own' : purpose)} onChange={(e) => setPurpose(e.target.value === '__own' ? '' : e.target.value)}>
          {purposes.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          <option value="__own">Write my own message</option>
        </Combo>
      </div>
      {langs.length > 1 && purpose && (
        <div className="field"><label>Language</label>
          <div className="msg-filter">{langs.map((l) => <button key={l} type="button" className={`msg-chip${language === l ? ' on' : ''}`} onClick={() => setLanguage(l)}>{l}</button>)}</div>
        </div>
      )}

      {channel === 'Email' && (
        <div className="field"><label htmlFor="rch-sub">Subject</label>
          <input id="rch-sub" value={baseSubject || ''} disabled={locked} onChange={(e) => setEdit({ subject: e.target.value, body: baseBody })} />
        </div>
      )}
      <div className="field">
        <label htmlFor="rch-body">Message (use &quot;Add a detail&quot; for name, job, date: each person gets their own)</label>
        <textarea
          id="rch-body" ref={bodyRef} className="msg-textarea" rows="5" value={baseBody || ''} disabled={locked}
          placeholder={writeOwn ? 'Type your message here.' : ''}
          onChange={(e) => setEdit({ subject: baseSubject, body: e.target.value })}
        />
        {!locked && <TokenPicker tokens={tokens && tokens.tokens} onPick={(k) => insertToken(bodyRef, baseBody, (v) => setEdit({ subject: baseSubject, body: v }), k)} />}
        {sms && !locked && <div className={`msg-count${sms.segments > 2 ? ' warn' : ''}`}>{sms.chars} letters = {sms.segments} SMS part(s)</div>}
        {locked && <div className="small-muted">{channel === 'WhatsApp' ? 'WhatsApp sends the wording Meta approved, so it cannot be changed here.' : 'This SMS is a registered template, so its words cannot be changed here.'}</div>}
        {edit && tpl && !locked && <button type="button" className="btn btn-sm" style={{ marginTop: 6 }} onClick={() => setEdit(null)}>Back to the template words</button>}
      </div>

      {cmpErr && <div className="msg-box red">{cmpErr}</div>}
      {reachable.length > 0 && (
        <div className="rch-prev">
          <div className="rch-prev-head">
            <b>What one person will get</b>
            <span className="rch-prev-nav">
              <button type="button" className="btn btn-sm" disabled={who <= 0} onClick={() => setWho(who - 1)}>‹ Previous</button>
              <span className="small-muted">{Math.min(who + 1, reachable.length)} of {reachable.length}</span>
              <button type="button" className="btn btn-sm" disabled={who >= reachable.length - 1} onClick={() => setWho(who + 1)}>Next ›</button>
            </span>
          </div>
          {preview && (
            <div className="msg-preview">
              <div className="to">To: <b>{preview.name}</b> · {preview.address}</div>
              {channel === 'Email' && preview.subject ? <div><b>{preview.subject}</b></div> : null}
              <Highlighted text={preview.text} />
            </div>
          )}
          <div className="small-muted">Never includes the client&apos;s name: candidates read &quot;our client&quot;.</div>
        </div>
      )}
    </Modal>
  );
}

// ---- NOT CONNECTED: open each chat in the sender's own app ------------------------------
function OwnAppQueue({
  channel, cmp, purposeLabel, onClose, onDone,
}) {
  const todo = useMemo(() => cmp.people.filter((p) => p.canOpen), [cmp]);
  const rest = useMemo(() => cmp.people.filter((p) => !p.canOpen), [cmp]);
  const [i, setI] = useState(0);
  const [log, setLog] = useState({}); // id -> 'opened' | 'skipped'
  const [msg, setMsg] = useState('');
  const [copied, setCopied] = useState(false);
  const cur = todo[i] || null;
  const finished = i >= todo.length;
  const mark = (id, v) => setLog((l) => ({ ...l, [id]: v }));
  const next = () => { setCopied(false); setMsg(''); setI((x) => x + 1); };

  async function opened(p) {
    mark(p.id, 'opened');
    try {
      await api.post('/messaging/reach/device-log', { candidateId: p.id, channel, text: p.text, subject: p.subject, purpose: purposeLabel });
      setMsg('Opened. Written on their history as "Opened in your app".');
    } catch (e) { setMsg(`Opened, but it could not be written on the history: ${e.response?.data?.error || 'try again'}`); }
  }
  const close = () => { if (onDone && Object.values(log).includes('opened')) onDone(); onClose(); };

  if (finished) {
    const people = [
      ...todo.map((p) => (log[p.id] === 'opened' ? { name: p.name, code: 'opened', word: 'Opened in your app', tone: 'green' } : { name: p.name, code: 'skipped_by_you', word: 'Skipped by you', tone: 'orange', reason: 'You skipped this one' })),
      ...rest,
    ];
    return (
      <Modal wide title={`${CHANNEL_LABEL[channel]} — done`} onClose={close} footer={<button type="button" className="btn btn-primary" onClick={close}>Done</button>}>
        <div className="msg-box blue">You selected {cmp.selected}: {Object.values(log).filter((v) => v === 'opened').length} opened in your app. TeamLink cannot see whether you pressed send in {channel === 'WhatsApp' ? 'WhatsApp' : 'that app'}, so these are not counted as Sent.</div>
        <ReachResult people={people} extra={cmp.outside ? [{ code: 'outside', word: 'Outside your access', tone: 'red', count: cmp.outside }] : []} />
      </Modal>
    );
  }
  return (
    <Modal
      title={`${CHANNEL_LABEL[channel]} — ${i + 1} of ${todo.length}`}
      onClose={close}
      footer={(
        <>
          <button type="button" className="btn" onClick={close}>Stop</button>
          <button type="button" className="btn" onClick={() => { mark(cur.id, log[cur.id] || 'skipped'); next(); }}>{log[cur.id] === 'opened' ? 'Next person →' : 'Skip'}</button>
        </>
      )}
    >
      <div className="rch-progress" aria-hidden="true"><span style={{ width: `${Math.round((i / Math.max(todo.length, 1)) * 100)}%` }} /></div>
      <div className="rch-who">
        <div className="rch-name">{cur.name}</div>
        <div className="small-muted">{cur.address}</div>
      </div>
      <div className="msg-preview">
        {channel === 'Email' && cur.subject ? <div><b>{cur.subject}</b></div> : null}
        <Highlighted text={cur.text} />
      </div>
      <div className="rch-actions">
        <a
          className="btn btn-primary"
          href={hrefOf(channel, { phone: cur.address, email: cur.address, address: cur.address, text: cur.text, subject: cur.subject })}
          target={channel === 'WhatsApp' ? '_blank' : undefined}
          rel="noopener noreferrer"
          onClick={() => opened(cur)}
        >{OPEN_WORD[channel]}</a>
        <button type="button" className="btn" onClick={async () => setCopied(await copyText(channel === 'Email' && cur.subject ? `${cur.subject}\n\n${cur.text}` : cur.text))}>{copied ? 'Copied' : 'Copy text'}</button>
      </div>
      {log[cur.id] === 'opened' && <div className="msg-box green">{msg || 'Opened.'} Press send in the app, then come back and choose <b>Next person</b>.</div>}
      <div className="small-muted">{channel === 'SMS' ? 'On a computer, use Copy text and paste it into your phone\'s messages.' : 'The message is already typed for you.'}</div>
    </Modal>
  );
}
