import { useWaSender } from '../messaging/WaSender.jsx';
import { useEffect, useState } from 'react';
import api from '../../api';
import Modal from '../Modal.jsx';
import { JobPickerCombo } from '../JobPicker.jsx';
import './broadcast.css';
import Combo from '../Combo.jsx';

// ---------------------------------------------------------------------------
// "SEND THIS JOB TO A LIST": job + message, the channel, a preview with one real contact, the count with every
// reason a person is skipped, the time (now / at / spread) and the plain truth about limits (days, caps).
// Starting needs: the permission tick for the list, the master switch (Admin), a connected WhatsApp.
// Server: POST /job-broadcast/campaigns/plan | /campaigns | /campaigns/:id/start
// ---------------------------------------------------------------------------
async function withConfirm(fn) {
  try { return await fn({}); } catch (e) {
    if (e.response?.status === 409 && e.response.data?.code === 'ACT_CONFIRM_SEND' && window.confirm(e.response.data.error)) return fn({ 'X-Act-Confirm': 'send' });
    throw e;
  }
}

export default function CampaignDialog({ jobId: jobIn = '', listId: listIn = '', onClose, onStarted }) {
  const [jobId, setJobId] = useState(jobIn);
  const [listId, setListId] = useState(listIn);
  const [lists, setLists] = useState([]);
  const [plan, setPlan] = useState(null);
  const [mode, setMode] = useState('now');
  const [startAt, setStartAt] = useState('');
  const [hours, setHours] = useState(8);
  const [firstN, setFirstN] = useState('');
  const [sms, setSms] = useState(false);
  const [tpl, setTpl] = useState('');
  const [tick, setTick] = useState(false);
  const [basis, setBasis] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [editText, setEditText] = useState(false);

  useEffect(() => { api.get('/job-broadcast/lists').then((r) => setLists(r.data.lists || [])).catch(() => {}); }, []);
  // the company WhatsApp number this broadcast leaves from (kept on the campaign; only numbers the Admin gave this login)
  const wa = useWaSender(true);
  const opts = () => ({ waNumberId: wa.numberId, firstN: Number(firstN) || undefined, mode, startAt: mode === 'at' && startAt ? new Date(startAt).toISOString() : undefined, spreadHours: mode === 'spread' ? hours : undefined, smsFallback: sms, templateId: tpl || undefined, text: editText ? text : undefined });
  const load = () => {
    if (!jobId || !listId) { setPlan(null); return; }
    api.post('/job-broadcast/campaigns/plan', { listId, jobId, ...opts() }).then((r) => { setPlan(r.data); setErr(''); if (!text) setText(r.data.text); }).catch((e) => { setPlan(null); setErr(e.response?.data?.error || 'Could not check the list.'); });
  };
  useEffect(load, [jobId, listId, firstN, mode, tpl]); // eslint-disable-line react-hooks/exhaustive-deps

  async function start() {
    setBusy(true); setErr('');
    try {
      if (plan.blockers.some((b) => b.code === 'NO_CONSENT')) {
        if (!tick) { setErr('Tick the permission box first.'); setBusy(false); return; }
        await api.post(`/job-broadcast/lists/${listId}/consent`, { confirm: true, basis });
      }
      const made = await api.post('/job-broadcast/campaigns', { listId, jobId, ...opts() });
      const id = made.data.campaign.id;
      const st = await withConfirm((headers) => api.post(`/job-broadcast/campaigns/${id}/start`, {}, { headers }));
      if (onStarted) onStarted(st.data.campaign);
    } catch (e) { setErr(e.response?.data?.error || 'That did not work. Please try again.'); load(); } finally { setBusy(false); }
  }
  const needConsent = plan && plan.blockers.some((b) => b.code === 'NO_CONSENT');
  const other = plan ? plan.blockers.filter((b) => b.code !== 'NO_CONSENT') : [];
  const ready = plan && other.length === 0 && (!needConsent || (tick && basis.trim().length >= 5));
  const c = plan && plan.counts;

  return (
    <Modal title="Send this requirement to a contact list" size="wide" onClose={onClose} foot={(
      <>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary bc-big" disabled={!ready || busy || !wa.canSend} onClick={start}>{busy ? 'Starting…' : (mode === 'at' ? 'Schedule it' : 'Send now')}</button>
      </>
    )}
    >
      <div className="grid-2">
        <label className="field"><span>1. The requirement</span><JobPickerCombo value={jobId} onChange={(e) => setJobId(e.target.value)} /></label>
        <label className="field"><span>2. The contact list</span>
          <Combo value={listId} onChange={(e) => setListId(e.target.value)}>
            <option value="">Choose a list…</option>
            {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Combo>
        </label>
      </div>
      {err && <div className="bc-err" role="alert">{err}</div>}
      {!plan && !err && <div className="bc-note">Choose a requirement and a list to see who will get it.</div>}
      {plan && (
        <>
          <div className="bc-box" style={{ margin: '8px 0' }}>
            <b style={{ fontSize: 15 }}>{plan.words}</b>
            <div className="bc-note" style={{ marginTop: 4 }}>
              {`${plan.channel.label || 'No WhatsApp connected'}${plan.channel.sandbox ? '' : ''}`}
              {plan.channel.reason ? ` · ${plan.channel.reason}` : ''}
            </div>
            <div style={{ marginTop: 6 }}>{plan.eta.words}</div>
            {plan.eta.days > 1 && <div className="bc-warn">WhatsApp does not allow thousands of messages in one day. {plan.eta.perDay} a day is the safe limit here, so this will take {plan.eta.days} days. Choose "Send first N today" to start with a few.</div>}
            {plan.channel.risk && <div className="bc-warn"><b>Be careful:</b> {plan.channel.risk}</div>}
          </div>

          <h4 style={{ fontSize: 13, margin: '10px 0 4px' }}>3. The message</h4>
          <div className="bc-wabg"><div className="bc-wa">{plan.preview.message}</div></div>
          <div className="bc-note" style={{ margin: '4px 0' }}>{`Preview with ${plan.preview.contact.name || 'a contact'} (${plan.preview.contact.phone}). Every person gets their own name, the requirement title, the place and the apply link.`}</div>
          <button type="button" className="btn btn-sm" onClick={() => setEditText((v) => !v)}>{editText ? 'Use the ready template text' : 'Change the words for this send'}</button>
          {editText && <textarea className="bc-text short" style={{ marginTop: 6 }} value={text} onChange={(e) => setText(e.target.value)} onBlur={load} aria-label="Message" />}
          {plan.channel.official && (
            <div style={{ marginTop: 8 }}>
              <div className="bc-note">The official WhatsApp API needs an approved message template for the first message.</div>
              {plan.templates.length === 0 && <div className="bc-warn">No approved template yet. An Admin adds one in Message templates and marks it Approved after Meta approves it.</div>}
              <div className="bc-versions">{plan.templates.map((t) => <button type="button" key={t.id} className={`bc-ver${tpl === t.id ? ' on' : ''}`} onClick={() => setTpl(t.id)}>{`${t.name} · Approved`}</button>)}</div>
            </div>
          )}

          {wa.node}
          <h4 style={{ fontSize: 13, margin: '12px 0 4px' }}>4. When</h4>
          <div className="bc-row" role="radiogroup">
            {[['now', 'Send now'], ['at', 'Send at a time'], ['spread', 'Spread over some hours']].map(([k, l]) => (
              <button type="button" key={k} className={`bc-tab${mode === k ? ' on' : ''}`} role="radio" aria-checked={mode === k} onClick={() => setMode(k)}>{l}</button>
            ))}
            {mode === 'at' && <input type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)} aria-label="Send at" />}
            {mode === 'spread' && <label className="bc-note">Over <input type="number" min="1" max="240" style={{ width: 70 }} value={hours} onChange={(e) => setHours(e.target.value)} /> hours</label>}
          </div>
          <div className="bc-row">
            <label className="bc-note">Send first <input type="number" min="1" style={{ width: 90 }} placeholder="all" value={firstN} onChange={(e) => setFirstN(e.target.value)} /> today, the rest on the next days</label>
            <label className="bc-note"><input type="checkbox" checked={sms} onChange={(e) => setSms(e.target.checked)} /> If WhatsApp does not work for a person, send an SMS instead</label>
          </div>
          <div className="bc-note">Nothing goes out between {plan.quiet.from}:00 and {plan.quiet.to}:00 (quiet hours). Everyone gets this requirement once. Anyone who replies STOP is never messaged again. You can pause or cancel any time.</div>

          {needConsent && (
            <div className="bc-consent">
              <label><input type="checkbox" checked={tick} onChange={(e) => setTick(e.target.checked)} />
                <span>These people gave permission to be contacted about jobs (or they are existing business contacts of the company).</span>
              </label>
              <input style={{ width: '100%', marginTop: 6 }} placeholder="Why may we contact them? For example: Client X gave us their staff contact list" value={basis} onChange={(e) => setBasis(e.target.value)} aria-label="Basis" />
              <div className="bc-note">This is saved in the audit log with the list.</div>
            </div>
          )}
          {other.length > 0 && other.map((b) => <div className="bc-warn" key={b.code}>{b.words}</div>)}
        </>
      )}
    </Modal>
  );
}
