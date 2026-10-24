import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import { Modal } from '../proto.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import JobProgress from './JobProgress.jsx';
import TokenPicker, { insertToken } from './TokenPicker.jsx';
import {
  useTokens, smsInfo, CHANNEL_ICON, STATUS_WORD, canManageTemplates, useUsable, useChannels, purposesFor, templateFor, Highlighted,
} from './msgKit.js';
import './messaging.css';
import Combo from '../Combo.jsx';
import { useWaSender } from './WaSender.jsx';
import AppCampaignModal from '../omni/library/AppCampaignModal.jsx'; // Omni-Channel: the same people and channels as a campaign (Save for later, approval, schedule, tracking)

// ---------------------------------------------------------------------------
// SEND A MESSAGE — to ONE person (SendMessageDialog) or to MANY (SendManyDialog).
//
//   One person:  How? (Email / SMS / WhatsApp) -> What for? -> see exactly what
//                they will get, with their own details filled in -> change the
//                words if you want -> Send. The answer is plain: Sent / Failed
//                (with the reason and a Try again) / Blocked (with the reason).
//   Many:        the same choices once for everybody, then "who gets it and who
//                is left out, and why", three real examples, a confirm
//                ("Send to 214 people?"), then live progress.
//
// The words come from Message templates. WhatsApp and registered (DLT) SMS
// templates are locked to the approved wording; Email and ordinary SMS can be
// changed before sending. Nothing here marks anything Sent: the server does,
// when the provider accepted it.
// ---------------------------------------------------------------------------

const WHO = { candidates: 'candidate', clients: 'client contact', employees: 'employee' };

function ManageLink({ user }) {
  if (!canManageTemplates(user)) return null;
  return <Link className="small-muted" to="/admin/message-templates" style={{ marginLeft: 8 }}>Edit the templates</Link>;
}

export { default as SendMessageDialog } from './ContactDialog.jsx';

// --------------------------- MANY PEOPLE --------------------------------------
const MODE_CHANNELS = { Email: ['Email'], WhatsApp: ['WhatsApp'], SMS: ['SMS'], Omnichannel: ['Email', 'SMS', 'WhatsApp'] };
export const BULK_LIMIT = 500;

export function SendManyDialog({
  mode, ids, candidateIds, audience = 'candidates', note, applicationId, requirementId, purposeLabel, onClose, onSent, app,
}) {
  const { user } = useAuth() || {};
  const targets = ids || candidateIds || [];
  const tokens = useTokens();
  const usable = useUsable(audience);
  const status = useChannels();
  const [channels, setChannels] = useState(MODE_CHANNELS[mode] || ['Email']);
  const [purpose, setPurpose] = useState(null);
  const [language, setLanguage] = useState('English');
  const [edits, setEdits] = useState({}); // channel -> { subject, body }
  const [pv, setPv] = useState(null);
  const [err, setErr] = useState('');
  const [stage, setStage] = useState('compose');
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState(null);
  const [fin, setFin] = useState(false);
  const [campaignOpen, setCampaignOpen] = useState(false); // "Make it a campaign" (Omni-Channel app campaign)
  const [tick, setTick] = useState(0); // a failed check tries again by itself (the server may be restarting)
  const tries = useRef(0);
  const refs = useRef({});
  const noun = WHO[audience] || 'person';
  const tooMany = targets.length > BULK_LIMIT;

  const purposes = useMemo(() => purposesFor(usable, channels), [usable, channels]);
  // purposeLabel (optional): open on the template with that name, e.g. "Client agreement link"
  useEffect(() => {
    if (purpose !== null || !purposes.length) return;
    const named = purposeLabel && purposes.find((p) => p.label.toLowerCase() === String(purposeLabel).toLowerCase());
    setPurpose((named || purposes[0]).key);
  }, [purposes, purpose]); // eslint-disable-line react-hooks/exhaustive-deps
  const writeOwn = purpose === '';
  const cur = purposes.find((p) => p.key === purpose);
  const langs = cur ? [...cur.languages] : ['English'];
  useEffect(() => { setEdits({}); }, [purpose, language]);
  const toggle = (c) => setChannels((cs) => (cs.includes(c) ? cs.filter((x) => x !== c) : [...cs, c]));

  const perChannel = useMemo(() => {
    const out = {};
    channels.forEach((c) => {
      const t = purpose ? templateFor(usable, purpose, c, language) : null;
      const e = edits[c];
      out[c] = { templateId: t ? t.id : undefined, ...(e ? { subject: e.subject, body: e.body } : {}) };
    });
    return out;
  }, [channels, purpose, language, edits, usable]);

  // WhatsApp: which company number the messages leave from (only the numbers the Admin gave this login)
  const wa = useWaSender(channels.includes('WhatsApp'));
  const request = {
    audience, ids: targets, channels, purposeKey: purpose || undefined, language, perChannel, applicationId, requirementId, purpose: writeOwn ? 'Message' : undefined,
    waNumberId: channels.includes('WhatsApp') ? wa.numberId : undefined,
  };
  const ready = !tooMany && targets.length && channels.length && purpose !== null && !(writeOwn && channels.some((c) => !(edits[c] && edits[c].body && edits[c].body.trim())));

  useEffect(() => {
    if (!ready || !usable || stage !== 'compose') { return undefined; }
    const t = setTimeout(() => {
      setErr('');
      api.post('/messaging/preview', request)
        .then((r) => { tries.current = 0; setPv(r.data); })
        .catch((e) => {
          setPv(null); setErr(e.response?.data?.error || 'Could not check the list. Trying again…');
          if ((!e.response || e.response.status >= 500) && tries.current < 5) { tries.current += 1; setTimeout(() => setTick((x) => x + 1), 2500); }
        });
    }, 350);
    return () => clearTimeout(t);
  }, [JSON.stringify(request), usable, stage, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  async function start() {
    setBusy(true); setErr('');
    try {
      const r = await api.post('/messaging/bulk', { ...request, confirmPeople: pv.peopleToSend });
      setJob(r.data); setStage('progress');
      if (onSent) onSent(r.data);
    } catch (e) {
      setErr(e.response?.data?.error || 'The send could not be started.'); setStage('compose');
    } finally { setBusy(false); }
  }

  if (stage === 'progress' && job) {
    return (
      <Modal wide title={`Sending to ${job.entities} ${noun}${job.entities === 1 ? '' : 's'}`} onClose={onClose} footer={<button type="button" className="btn btn-primary" onClick={onClose}>{fin ? 'Done' : 'Close (sending goes on)'}</button>}>
        <JobProgress jobId={job.id} initial={job} noun={noun} onJob={(j) => setFin(!['queued', 'running', 'cancelling'].includes(j.status))} />
        {channels.includes('WhatsApp') && (
          <div className="notice" style={{ marginTop: 12 }}>
            <b>Where the replies come:</b> in Follow-ups → WhatsApp chats. What you sent and what they answer are in the <b>same chat</b>, in order.
            {' '}<Link className="btn btn-sm btn-primary" to={targets.length === 1 ? `/ats/followups?sub=chats&chat=${{ candidates: 'CANDIDATE', clients: 'CLIENT', employees: 'EMPLOYEE' }[audience] || 'CANDIDATE'}:${encodeURIComponent(targets[0])}` : '/ats/followups?sub=chats'} onClick={onClose}>{targets.length === 1 ? 'Open this conversation' : 'Open WhatsApp chats'}</Link>
          </div>
        )}
      </Modal>
    );
  }

  if (stage === 'confirm' && pv) {
    return (
      <Modal
        title={`Send to ${pv.peopleToSend} ${pv.peopleToSend === 1 ? noun : `${noun}s`}?`}
        onClose={onClose}
        footer={<>
          <button type="button" className="btn" onClick={() => setStage('compose')}>No, go back</button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={start}>{busy ? 'Starting…' : `Yes, send to ${pv.peopleToSend}`}</button>
        </>}
      >
        <div className="msg-box blue">
          {channels.map((c) => `${pv.sendByChannel[c] || 0} by ${c === 'SMS' ? 'SMS' : c}`).join(' · ')}.
          {' '}Once sent, a message cannot be taken back. You can stop the rest while it is going.
        </div>
        {(pv.skipped > 0 || pv.blocked > 0) && <div className="small-muted">{pv.skipped + pv.blocked} will not get it ({pv.blocked} blocked, {pv.skipped} skipped). You saw the reasons on the last screen.</div>}
        {err && <div className="msg-box red">{err}</div>}
      </Modal>
    );
  }

  return (
    <Modal
      wide
      title={`Send to ${targets.length} ${targets.length === 1 ? noun : `${noun}s`}`}
      onClose={onClose}
      footer={<>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn" disabled={!targets.length || tooMany} title="Keep the same people as a campaign: save it for later, ask for approval, schedule it and follow every message" onClick={() => setCampaignOpen(true)}>Make it a campaign…</button>
        <button type="button" className="btn btn-primary" disabled={!pv || !(pv.peopleToSend > 0) || (channels.includes('WhatsApp') && channels.length === 1 && !wa.canSend)} onClick={() => setStage('confirm')}>
          {pv && pv.peopleToSend > 0 ? `Next: send to ${pv.peopleToSend}` : 'Nobody to send to yet'}
        </button>
      </>}
    >
      {campaignOpen && <AppCampaignModal app={app || (audience === 'employees' ? 'HRMS' : 'ATS')} audience={audience} ids={targets} channels={channels} onClose={() => setCampaignOpen(false)} onSaved={() => {}} />}
      {note && <div className="notice" style={{ marginBottom: 10 }}>{note}</div>}
      {tooMany && <div className="msg-box red">{targets.length} chosen. At most {BULK_LIMIT} at a time. Narrow the list and send in batches.</div>}

      <div className="field">
        <label>How?</label>
        <div className="msg-chbtns">
          {['Email', 'SMS', 'WhatsApp'].map((ch) => {
            const st = status && status[ch];
            return (
              <button key={ch} type="button" className={`msg-chbtn${channels.includes(ch) ? ' on' : ''}`} onClick={() => toggle(ch)}>
                {channels.includes(ch) ? '✓ ' : ''}{CHANNEL_ICON[ch]} {ch === 'SMS' ? 'Text (SMS)' : ch}
                <small>{st ? (st.configured ? 'Ready' : 'Not set up yet') : ''}</small>
              </button>
            );
          })}
        </div>
      </div>

      <div className="field">
        <label>What is it for?<ManageLink user={user} /></label>
        <Combo value={purpose === null ? '' : (writeOwn ? '__own' : purpose)} onChange={(e) => setPurpose(e.target.value === '__own' ? '' : e.target.value)}>
          {purposes.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          <option value="__own">Write my own message</option>
        </Combo>
      </div>
      {langs.length > 1 && !writeOwn && (
        <div className="field">
          <label>Language</label>
          <div className="msg-filter">{langs.map((l) => <button key={l} type="button" className={`msg-chip${language === l ? ' on' : ''}`} onClick={() => setLanguage(l)}>{l}</button>)}</div>
        </div>
      )}

      {channels.includes('WhatsApp') && wa.node}
      {channels.map((c) => {
        const t = purpose ? templateFor(usable, purpose, c, language) : null;
        const locked = !!(t && t.locked);
        const e = edits[c];
        const shown = e ? e.body : (t ? t.body : '');
        const subj = e ? e.subject : (t ? t.subject : '');
        return (
          <div key={c} className="mt-card">
            <h4>{CHANNEL_ICON[c]} {c === 'SMS' ? 'Text (SMS)' : c}{t ? <span className="small-muted"> · {t.name} (version {t.version})</span> : <span className="small-muted"> · {writeOwn ? 'your own words' : 'no ready-made message for this'}</span>}</h4>
            {c === 'Email' && <input value={subj} placeholder="Subject" disabled={locked} onChange={(ev) => setEdits({ ...edits, [c]: { subject: ev.target.value, body: shown } })} style={{ marginBottom: 6 }} />}
            <textarea
              ref={(el) => { refs.current[c] = { current: el }; }}
              className="msg-textarea" rows="4" value={shown} disabled={locked}
              placeholder={writeOwn ? 'Type your message. Use "Add a detail" for names, jobs and dates.' : ''}
              onChange={(ev) => setEdits({ ...edits, [c]: { subject: subj, body: ev.target.value } })}
            />
            {!locked && <TokenPicker tokens={tokens && tokens.tokens} onPick={(k) => insertToken(refs.current[c], shown, (v) => setEdits({ ...edits, [c]: { subject: subj, body: v } }), k)} />}
            {locked && <div className="small-muted">{c === 'WhatsApp' ? 'WhatsApp only sends the wording Meta approved. To change it, edit the template.' : 'Registered SMS template: change the words in the template.'}</div>}
            {c === 'SMS' && !locked && <div className="msg-count">{smsInfo(shown).chars} letters = {smsInfo(shown).segments} SMS part(s)</div>}
          </div>
        );
      })}

      {err && <div className="msg-box red">{err}</div>}
      {pv && (
        <div>
          <div className="msg-box blue">
            <span className="msg-bignum">{pv.peopleToSend}</span> {pv.peopleToSend === 1 ? noun : `${noun}s`} will get it
            {channels.length > 1 ? ` (${channels.map((c) => `${pv.sendByChannel[c] || 0} ${c}`).join(', ')})` : ''}.
            {pv.outOfScope > 0 && <div>{pv.outOfScope} chosen are outside your access and are left out.</div>}
          </div>
          {pv.notSent.length > 0 && (
            <div className="msg-details">
              <b style={{ fontSize: 13 }}>Left out ({pv.skipped + pv.blocked}) and why</b>
              {pv.notSent.map((n, i) => (
                <details key={i} open={pv.notSent.length <= 3}>
                  <summary><span className={`status ${n.status === 'blocked' ? 'rejected' : 'pending'}`}>{STATUS_WORD[n.status]}</span> {n.count} × {n.channel}: {n.reason}</summary>
                  <div className="msg-names">{n.names.join(', ')}{n.count > n.names.length ? ` and ${n.count - n.names.length} more` : ''}</div>
                </details>
              ))}
            </div>
          )}
          {pv.sample.length > 0 && (
            <div>
              <b style={{ fontSize: 13 }}>Three examples, with their real details</b>
              {pv.sample.map((s, i) => (
                <div key={i} className="msg-sample">
                  <b>{s.name} · {s.channel} · {s.address}</b>
                  {s.subject ? <div><b style={{ display: 'inline' }}>{s.subject}</b></div> : null}
                  <div style={{ whiteSpace: 'pre-wrap' }}><Highlighted text={s.text} /></div>
                </div>
              ))}
            </div>
          )}
          {pv.limits && channels.map((c) => pv.limits[c] && (
            <div key={c} className="small-muted">{c}: {pv.limits[c].usedToday} sent or waiting today of {pv.limits[c].perDay} allowed.</div>
          ))}
        </div>
      )}
    </Modal>
  );
}

export default SendManyDialog;
