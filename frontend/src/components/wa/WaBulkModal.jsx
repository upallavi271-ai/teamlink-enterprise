import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import Modal from '../Modal.jsx';
import Combo from '../Combo.jsx';
import { buildWaLink, fillPlaceholders } from '../../utils/waLink';
import { loadWaTemplates, openWa, errText, useWaConfig, WA_ICON } from './waKit.js';
import './wa.css';

// ---------------------------------------------------------------------------
// SEND WHATSAPP TO MANY (queue mode, free wa.me links). TeamLink sends nothing: each person is one click that opens WhatsApp in a new tab.
//   1. Pick a template. The list shows each person's own message; people with no / bad number, the same number again, people who are not
//      opted in and people on the do-not-contact list are left out automatically.
//   2. "Start the list" saves it on the server (so it survives closing this window, or another computer).
//   3. "Open next" opens the NEXT person (one tab per click: browsers block many tabs at once). Each row also has its own Send button.
//   4. The summary says how many were sent and how many were skipped, and why.
// Props: entityType, ids[] (a new list)  OR  sessionId (resume an open one);  requirementId optional;  onClose, onDone
// ---------------------------------------------------------------------------
const WHY = { invalid: 'No valid number', duplicate: 'Same number as an earlier person', not_opted_in: 'Not opted in', dnc: 'Do not contact', missing: 'Message needs details we do not have' };

function Summary({ s }) {
  const c = s.counts;
  return (
    <div>
      <div className="wa-sum" aria-label="Summary">
        <span className="wa-chip g">{c.sent} sent</span>
        {c.pending > 0 && <span className="wa-chip">{c.pending} not sent yet</span>}
        <span className="wa-chip a">{c.skippedTotal} skipped</span>
      </div>
      {c.skippedTotal > 0 && (
        <div className="small-muted" style={{ marginBottom: 8 }}>
          Skipped: {Object.entries(c.skipped).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${(WHY[k] || k).toLowerCase()}`).join(' · ')}
        </div>
      )}
    </div>
  );
}

export default function WaBulkModal({ entityType, ids, sessionId, requirementId, onClose, onDone }) {
  const [phase, setPhase] = useState(sessionId ? 'run' : 'pick'); // pick | run | summary
  const [templates, setTemplates] = useState([]);
  const [tplId, setTplId] = useState('');
  const [plan, setPlan] = useState(null); // { recipients, cc }
  const [sess, setSess] = useState(null); // the server session (state of every person)
  const [local, setLocal] = useState({}); // personId -> { number, message } for the people still to message
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [limit, setLimit] = useState(null);
  const [note, setNote] = useState('');
  const cfg = useWaConfig();

  const mod = { candidate: 'ATS', client: 'ATS', employee: 'HRMS', vendor: 'Accounts', invoice: 'Accounts' }[entityType || (sess && sess.entityType)];

  // load templates (+ the plan when starting a new list)
  useEffect(() => {
    let live = true;
    loadWaTemplates().then((t) => { if (live) setTemplates(t); }).catch(() => {});
    if (!sessionId && ids && ids.length) {
      api.post('/wa/recipients', { entityType, ids, requirementId }).then((r) => { if (live) setPlan({ recipients: r.data.recipients || [], cc: r.data.settings.defaultCountryCode }); })
        .catch((e) => { if (live) setError(errText(e, 'Could not get the list ready.')); });
    }
    return () => { live = false; };
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  const applySession = (s, keep = true) => {
    setSess((prev) => {
      if (!keep || !prev) return s;
      return s;
    });
    setLimit(s.limit || null);
  };

  // resume: fetch the saved list with the numbers + messages of the people still to message
  useEffect(() => {
    if (!sessionId) return undefined;
    let live = true;
    api.get(`/wa/bulk/${sessionId}`).then((r) => {
      if (!live) return;
      const s = r.data.session;
      const map = {};
      s.items.forEach((i) => { if (i.state === 'pending') map[i.id] = { number: i.number, message: i.message }; });
      setLocal(map); applySession(s);
      setPhase(s.status === 'open' ? 'run' : 'summary');
    }).catch((e) => { if (live) setError(errText(e, 'Could not open this list.')); });
    return () => { live = false; };
  }, [sessionId]);

  const tpl = templates.find((t) => t.id === tplId) || null;
  const rows = useMemo(() => {
    if (!plan) return [];
    const seen = new Set();
    return plan.recipients.map((p) => {
      const fill = tpl ? fillPlaceholders(tpl.body, p.vars) : { text: '', missing: [] };
      let skip = null;
      if (!p.valid) skip = 'invalid'; else if (p.dnc) skip = 'dnc'; else if (p.optInRequired && !p.optedIn) skip = 'not_opted_in'; else if (seen.has(p.cleaned)) skip = 'duplicate'; else if (tpl && fill.missing.length) skip = 'missing';
      if (!skip) seen.add(p.cleaned);
      return { p, skip, text: fill.text, missing: fill.missing };
    });
  }, [plan, tpl]);
  const readyN = rows.filter((r) => !r.skip).length;
  const skipN = rows.length - readyN;

  async function start() {
    setBusy(true); setError('');
    try {
      const r = await api.post('/wa/bulk', { entityType, ids, templateId: tplId, requirementId });
      const id = r.data.session.id;
      const g = await api.get(`/wa/bulk/${id}`);
      const s = g.data.session;
      const map = {};
      s.items.forEach((i) => { if (i.state === 'pending') map[i.id] = { number: i.number, message: i.message }; });
      setLocal(map); applySession(s); setPhase('run');
    } catch (e) { setError(errText(e, 'Could not start the list.')); } finally { setBusy(false); }
  }

  async function sendOne(item) {
    if (busy || !sess) return;
    const l = local[item.id];
    const link = l && buildWaLink(l.number, l.message, '91');
    if (!link) { setError(`${item.name} has no valid number.`); return; }
    openWa(link); // straight from the click
    setBusy(true); setError('');
    try {
      const r = await api.post(`/wa/bulk/${sess.id}/sent`, { personId: item.id });
      const s = r.data.session;
      setSess((prev) => ({ ...prev, ...s, items: prev.items.map((i) => { const n = s.items.find((x) => x.id === i.id); return n ? { ...i, state: n.state } : i; }) }));
      setLimit(s.limit || null);
      if (s.status === 'done') { setPhase('summary'); if (onDone) onDone(); }
    } catch (e) { setError(errText(e, 'It opened, but could not be marked as sent. Press Send on that row again later.')); } finally { setBusy(false); }
  }
  const nextItem = sess && sess.items.find((i) => i.state === 'pending');
  const counts = useMemo(() => {
    if (!sess) return null;
    const c = { total: sess.items.length, sent: 0, pending: 0, skipped: { invalid: 0, duplicate: 0, not_opted_in: 0, dnc: 0, missing: 0 }, skippedTotal: 0 };
    sess.items.forEach((i) => { if (i.state === 'sent') c.sent += 1; else if (i.state === 'pending') c.pending += 1; else if (i.state === 'skipped') { c.skippedTotal += 1; if (c.skipped[i.reason] != null) c.skipped[i.reason] += 1; } });
    return c;
  }, [sess]);
  const toSend = counts ? counts.sent + counts.pending : 0;

  async function finish(discard) {
    if (!sess) { onClose(); return; }
    try {
      const r = await api.post(`/wa/bulk/${sess.id}/${discard ? 'discard' : 'finish'}`);
      if (!discard) { setSess((prev) => ({ ...prev, status: r.data.session.status })); setPhase('summary'); } else { onClose(); }
      if (onDone) onDone();
    } catch (e) { setError(errText(e, 'Could not close the list.')); }
  }

  const title = `${WA_ICON} Send WhatsApp${phase === 'pick' && ids ? ` to ${ids.length} ${ids.length === 1 ? 'person' : 'people'}` : ''}`;
  let footer;
  if (phase === 'pick') {
    footer = (
      <div className="wa-foot">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn wa-go" disabled={!tplId || readyN === 0 || busy} onClick={start}>{readyN ? `Start the list (${readyN})` : 'Start the list'}</button>
      </div>
    );
  } else if (phase === 'run') {
    footer = (
      <div className="wa-foot">
        <button type="button" className="btn" onClick={() => finish(true)} title="Forget this list">Cancel the list</button>
        <button type="button" className="btn" onClick={onClose} title="Your place is saved. Open this list again from the green bar on the page.">Close for now</button>
        <button type="button" className="btn" onClick={() => finish(false)}>Finish</button>
        <button type="button" className="btn wa-go" disabled={!nextItem || busy} onClick={() => nextItem && sendOne(nextItem)}>{nextItem ? `Open next: ${nextItem.name}` : 'All done'}</button>
      </div>
    );
  } else {
    footer = <div className="wa-foot"><button type="button" className="btn wa-go" onClick={onClose}>Close</button></div>;
  }

  return (
    <Modal title={title} size="xwide" onClose={onClose} footer={footer}>
      {error && <div className="wa-note bad" role="alert">{error}</div>}
      {note && <div className="wa-note info">{note}</div>}

      {phase === 'pick' && (
        <>
          <div className="wa-field">
            <label>Template {cfg.mayEditTemplates && <a className="link-btn" href="/admin/message-templates?tab=whatsapp" target="_blank" rel="noopener">Edit templates</a>}</label>
            <Combo value={tplId} onChange={(e) => setTplId(e.target.value)}>
              <option value="">Pick a template...</option>
              {templates.filter((t) => t.module === mod || t.module === 'General').map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Combo>
          </div>
          {!plan && !error && <div className="small-muted">Getting the list ready...</div>}
          {plan && (
            <>
              <div className="wa-sum">
                <span className="wa-chip">{rows.length} selected</span>
                <span className="wa-chip g">{readyN} will get a message</span>
                {skipN > 0 && <span className="wa-chip a">{skipN} left out</span>}
              </div>
              <div className="wa-note info">You open each chat yourself, one at a time. People who are not opted in, have no valid number, repeat a number or asked not to be contacted are left out.</div>
              <div className="wa-list" role="list">
                {rows.map(({ p, skip, text, missing }) => (
                  <div key={p.key} role="listitem" className={`wa-row${skip ? ' is-skip' : ''}`}>
                    <div>
                      <b>{p.name}</b> <span className="small-muted">{p.valid ? `+${p.cleaned.slice(0, p.cleaned.length - 10)} ••••••${p.cleaned.slice(-4)}` : ''}</span>
                      {skip && <div className="wa-row-why">Left out: {WHY[skip]}{skip === 'missing' && missing.length ? ` (${missing.map((k) => `{${k}}`).join(' ')})` : ''}</div>}
                      {!skip && tpl && <div className="wa-row-msg">{text}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {phase !== 'pick' && sess && counts && (
        <>
          {limit && limit.overLimit && (
            <div className="wa-note warn">You have already opened {limit.sentToday} chats today (the daily limit is {limit.dailyBulkLimit}). You can go on, but WhatsApp may restrict numbers that message many people who did not ask.</div>
          )}
          <div><b>{counts.sent}/{toSend} sent</b> <span className="small-muted">· {sess.templateName || 'your message'}{counts.skippedTotal ? ` · ${counts.skippedTotal} left out` : ''}</span></div>
          <div className="wa-prog" aria-hidden="true"><i style={{ width: `${toSend ? Math.round((counts.sent / toSend) * 100) : 0}%` }} /></div>
          {phase === 'summary' && <Summary s={{ counts }} />}
          <div className="wa-list" role="list">
            {sess.items.map((i) => {
              const l = local[i.id];
              return (
                <div key={i.id} role="listitem" className={`wa-row${i.state === 'sent' ? ' is-sent' : i.state === 'skipped' ? ' is-skip' : ''}`}>
                  <div>
                    <b>{i.name}</b>{' '}
                    {i.state === 'sent' && <span className="status active">Sent</span>}
                    {i.state === 'skipped' && <span className="status pending">Left out</span>}
                    {i.state === 'pending' && <span className="status">Not sent yet</span>}
                    {i.state === 'skipped' && <div className="wa-row-why">{WHY[i.reason] || 'Left out'}{i.reason === 'missing' && i.missing ? ` (${i.missing.map((k) => `{${k}}`).join(' ')})` : ''}</div>}
                    {i.state === 'pending' && l && <div className="wa-row-msg">{l.message}</div>}
                  </div>
                  {i.state === 'pending' && phase === 'run' && <button type="button" className="btn btn-sm wa-go" disabled={busy} onClick={() => sendOne(i)} aria-label={`Send to ${i.name}`}>Send</button>}
                </div>
              );
            })}
          </div>
          <div className="small-muted" style={{ marginTop: 8 }}>TeamLink does not send anything. Each Send opens WhatsApp in a new tab, and you press Send there. WhatsApp does not tell us if it was delivered.</div>
        </>
      )}
    </Modal>
  );
}
