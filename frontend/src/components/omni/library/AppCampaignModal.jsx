import { useEffect, useMemo, useRef, useState } from 'react';
import { shared, errOf } from '../omniApi.js';
import { Banner, Btn, GsModal } from '../ui.jsx';
import Combo from '../../Combo.jsx';
import { useWaSender } from '../../messaging/WaSender.jsx';
import './library.css';

// ---------------------------------------------------------------------------
// A CAMPAIGN FROM AN APP SCREEN (ATS candidates, Job Portal applicants, HRMS employees, Accounts clients' billing contacts).
// The people were picked on the app screen (ids); this window picks the message from the shared Template library (only what that app may use and what is approved),
// shows the real preview (each person's own words, who is left out and why, "this is only a rehearsal" while Test mode is on) and then:
//   Save for later  ·  Ask for approval  ·  Send now  ·  Schedule
// Everything is checked again by the server (POST /api/omni/app-campaigns/...); this window only draws the answers.
//   props: app ('ATS' | 'Job Portal' | 'HRMS' | 'Accounts'), audience ('candidates' | 'clients' | 'employees'), ids, channels (optional start), existing (a saved campaign = edit), onClose, onSaved(id)
// ---------------------------------------------------------------------------
const CHANNELS = ['Email', 'SMS', 'WhatsApp'];
const WHO = { candidates: 'candidates', clients: 'client contacts', employees: 'employees' };

export default function AppCampaignModal({ app, audience, ids, channels: startChannels, existing, onClose, onSaved, toast = () => {} }) {
  const [lib, setLib] = useState(null);
  const [name, setName] = useState(existing ? existing.name : '');
  const [channels, setChannels] = useState(existing ? existing.channels : (startChannels && startChannels.length ? startChannels : ['Email']));
  const [purpose, setPurpose] = useState('');
  const [language, setLanguage] = useState('English');
  const [pv, setPv] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [later, setLater] = useState(false);
  const [at, setAt] = useState('');
  const [done, setDone] = useState(null);
  const timer = useRef(null);

  useEffect(() => { shared.get('/library/templates', { app }).then((r) => setLib(r)).catch((e) => setErr(errOf(e, 'The template library could not be read.'))); }, [app]);
  // one choice per "what is it for": the templates of that purpose that this app may use
  const options = useMemo(() => {
    const m = new Map();
    ((lib && lib.items) || []).filter((t) => t.source === 'message' && t.canUseHere && t.purpose).forEach((t) => {
      const o = m.get(t.purpose) || { purpose: t.purpose, label: t.group || t.purpose, channels: new Set(), languages: new Set() };
      o.channels.add(t.channel); o.languages.add(t.language || 'English'); m.set(t.purpose, o);
    });
    return [...m.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [lib]);
  useEffect(() => { if (!purpose && existing && existing.purposeKey) setPurpose(existing.purposeKey); }, [existing]); // eslint-disable-line react-hooks/exhaustive-deps
  const cur = options.find((o) => o.purpose === purpose);
  const langs = cur ? [...cur.languages] : ['English'];
  const usable = (c) => !cur || cur.channels.has(c);

  // WhatsApp: the company number this campaign leaves from (kept on the campaign; only numbers the Admin gave this login)
  const wa = useWaSender(channels.includes('WhatsApp'));
  const body = useMemo(() => ({ app, audience, ids, channels, purposeKey: purpose, language, name, waNumberId: channels.includes('WhatsApp') ? wa.numberId : undefined }), [app, audience, ids, channels, purpose, language, name, wa.numberId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!purpose || !channels.length || existing) { setPv(null); return undefined; }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setErr('');
      shared.post('/app-campaigns/preview', body).then((r) => setPv(r)).catch((e) => { setPv(null); setErr(errOf(e, 'The list could not be checked.')); });
    }, 350);
    return () => clearTimeout(timer.current);
  }, [JSON.stringify(body)]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (c) => setChannels((cs) => (cs.includes(c) ? cs.filter((x) => x !== c) : [...cs, c]));
  const save = async () => (existing ? shared.put(`/app-campaigns/${existing.id}`, { name, channels, purposeKey: purpose, language }).then(() => ({ id: existing.id })) : shared.post('/app-campaigns', body));
  const act = async (kind) => {
    setBusy(true); setErr('');
    try {
      const s = await save();
      const id = s.id;
      let msg = 'Saved. It is not sent yet.';
      if (kind === 'approval') msg = (await shared.post(`/app-campaigns/${id}/submit`)).ok;
      if (kind === 'send') { const r = await shared.post(`/app-campaigns/${id}/send`, { when: 'now' }); msg = r.ok; }
      if (kind === 'later') { const r = await shared.post(`/app-campaigns/${id}/send`, { when: 'later', at: new Date(at).toISOString() }); msg = r.ok; }
      toast(msg);
      if (onSaved) onSaved(id, kind);
      setDone({ id, msg });
    } catch (e) { setErr(errOf(e, 'That did not work.')); } finally { setBusy(false); }
  };

  const p = pv && pv.preview;
  const canGo = !!purpose && channels.length > 0 && (existing || (p && true)) && !(channels.includes('WhatsApp') && channels.length === 1 && !wa.canSend);
  return (
    <div className="gsx" style={{ background: 'transparent', minHeight: 0, overflow: 'visible', display: 'block' }}>
      <GsModal title={existing ? 'Change the campaign' : `New campaign from ${app}`} sub={`${ids.length} ${WHO[audience] || 'people'} picked on the ${app} screen`} width={720} onClose={onClose}
        foot={done ? <Btn primary onClick={onClose}>Done</Btn> : <>
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn disabled={busy || !canGo} onClick={() => act('save')}>Save for later</Btn>
          {!existing && <Btn disabled={busy || !canGo} onClick={() => act('approval')}>Ask for approval</Btn>}
          {!existing && <Btn disabled={busy || !canGo || later} onClick={() => setLater(true)}>Schedule…</Btn>}
          {!existing && <Btn primary disabled={busy || !canGo || !(p && p.toSend > 0)} onClick={() => act('send')}>{pv && pv.rehearsal ? 'Send (rehearsal)' : 'Send now'}</Btn>}
        </>}>
        {done ? <Banner tone="ok">{done.msg} You can follow it in <b>Campaigns &gt; From other apps</b>{app ? ` (or the "Templates & campaigns" button of ${app})` : ''}.</Banner> : <>
          {err && <Banner tone="error">{err}</Banner>}
          <div className="field full"><label>Campaign name</label><input className="input" value={name} placeholder="For example: Interview reminder for Monday" onChange={(e) => setName(e.target.value)} /></div>
          <div className="field full">
            <label>What is it for? (from the template library)</label>
            <Combo value={purpose} onChange={(e) => setPurpose(e.target.value)} aria-label="Template">
              <option value="">Pick a message…</option>
              {options.map((o) => <option key={o.purpose} value={o.purpose}>{o.label}</option>)}
            </Combo>
            {lib && options.length === 0 && <small>No template is shared with {app} for your login yet. Open the template library and tick {app} under "Used in".</small>}
          </div>
          <div className="field full">
            <label>How?</label>
            <div className="lib-inline">{CHANNELS.map((c) => <label key={c} className={`lib-chip${channels.includes(c) ? ' on' : ''}`} style={{ opacity: usable(c) ? 1 : 0.45 }}><input type="checkbox" checked={channels.includes(c)} disabled={!usable(c)} onChange={() => toggle(c)} /> {c === 'SMS' ? 'Text (SMS)' : c}</label>)}</div>
          </div>
          {channels.includes('WhatsApp') && wa.node && <div className="field full">{wa.node}</div>}
          {langs.length > 1 && <div className="field full"><label>Language</label><Combo value={language} onChange={(e) => setLanguage(e.target.value)} aria-label="Language">{langs.map((l) => <option key={l} value={l}>{l}</option>)}</Combo></div>}
          {pv && <Banner tone={pv.rehearsal ? 'test' : 'info'}>{pv.modeWords}</Banner>}
          {pv && pv.needsApproval && <Banner tone="warn">This campaign needs approval before it is sent. Press "Ask for approval".</Banner>}
          {p && (
            <div className="lib-box">
              <b>{p.toSend} message{p.toSend === 1 ? '' : 's'} will go to {p.peopleToSend} {p.peopleToSend === 1 ? 'person' : 'people'}.</b>
              {p.outOfScope > 0 && <div className="lib-sub">{p.outOfScope} are outside your access and were left out.</div>}
              {(p.skipped + p.blocked) > 0 && <div style={{ marginTop: 6 }}><b>Left out ({p.skipped + p.blocked}):</b><ul className="lib-ul">{p.notSent.map((n) => <li key={`${n.status}${n.channel}${n.reason}`}>{n.count} by {n.channel}: {n.reason}</li>)}</ul></div>}
              {p.sample.length > 0 && <div style={{ marginTop: 6 }}><div className="lib-sub">What {p.sample[0].name} will get ({p.sample[0].channel})</div><div className="lib-body">{p.sample[0].subject ? <b>{p.sample[0].subject}<br /></b> : null}{p.sample[0].text}</div></div>}
            </div>
          )}
          {later && !existing && (
            <div className="field full"><label>Send it on</label>
              <div className="lib-inline"><input className="input" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} aria-label="Date and time" />
                <Btn primary disabled={busy || !at || new Date(at).getTime() < Date.now() + 60000} onClick={() => act('later')}>Schedule it</Btn><Btn onClick={() => setLater(false)}>Not now</Btn></div>
              <small>India time. It goes out by itself at that time, as you. You can pause or cancel it before then.</small></div>
          )}
        </>}
      </GsModal>
    </div>
  );
}
