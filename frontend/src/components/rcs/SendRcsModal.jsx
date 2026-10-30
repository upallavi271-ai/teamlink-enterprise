import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import Modal from '../Modal.jsx';
import Combo from '../Combo.jsx';
import '../comm/comm.css';
import '../comm/smsPlatform.css';

// ---------------------------------------------------------------------------
// "Send RCS" from the ATS candidates list and the HRMS employees list (one person or the ticked ones).
// Approved templates only; a field per blank (var1, var2 … ; {name} / {firstName} put each person's own name); preview; who is left out
// and why, BEFORE sending; then the background queue's progress. The numbers never come to this screen (the server looks them up).
// audience: 'candidates' | 'employees'
// ---------------------------------------------------------------------------
const errOf = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d;
const VAR_RE = /\{\{\s*(var\d{1,2})\s*\}\}|\{#\s*(var\d{1,2})\s*#\}|\[(var\d{1,2})\]|\{(var\d{1,2})\}/gi;
const MODULE = { candidates: 'ATS', employees: 'HRMS' };

export function useRcsMay() {
  const [may, setMay] = useState(false);
  useEffect(() => { api.get('/rcs/status').then((r) => setMay(!!(r.data && r.data.may && r.data.may.send))).catch(() => setMay(false)); }, []);
  return may;
}

function previewOf(tpl, card, firstName, fullName) {
  const fill = (v) => String(v || '').replace(/\{\s*name\s*\}/gi, fullName || 'Name').replace(/\{\s*firstName\s*\}/gi, firstName || 'Name');
  const text = `${tpl.title ? `${tpl.title}\n` : ''}${tpl.description || ''}`;
  if (!text.trim()) return Object.entries(card).map(([k, v]) => `${k}: ${fill(v)}`).join('\n');
  return text.replace(VAR_RE, (m, a, b, c, d) => { const k = (a || b || c || d).toLowerCase(); return card[k] ? fill(card[k]) : `[${k}]`; });
}

export default function SendRcsModal({ audience, ids, onClose, onSent }) {
  const [tpls, setTpls] = useState(null);
  const [tplId, setTplId] = useState('');
  const [cards, setCards] = useState([{}]);
  const [buttonUrl, setButtonUrl] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [check, setCheck] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [batch, setBatch] = useState(null);
  const [progress, setProgress] = useState(null);

  useEffect(() => {
    api.get('/rcs/templates', { params: { approved: 1, module: MODULE[audience] } }).then((r) => setTpls(r.data)).catch((e) => { setTpls([]); setErr(errOf(e, 'Could not load the templates.')); });
  }, [audience]);
  const tpl = useMemo(() => (tpls || []).find((t) => t.id === tplId) || null, [tpls, tplId]);
  const cardCount = tpl ? (tpl.rcsType === 'RICHCASOUREL' ? tpl.cards : 1) : 1;
  const blanks = tpl ? Array.from({ length: tpl.varCount }, (_, i) => `var${i + 1}`) : [];

  useEffect(() => {
    setCheck(null);
    if (!tplId) return;
    api.post('/rcs/check', { audience, ids, templateId: tplId }).then((r) => setCheck(r.data)).catch((e) => setErr(errOf(e, 'Could not check the people.')));
  }, [tplId, audience, ids]);
  useEffect(() => {
    if (!batch) return undefined;
    let stop = false;
    const tick = async () => {
      try { const r = await api.get(`/rcs/batches/${batch.batchId}`); if (!stop) setProgress(r.data); if (r.data.status !== 'done' && !stop) setTimeout(tick, 2500); } catch { /* the next look shows it */ }
    };
    tick();
    return () => { stop = true; };
  }, [batch]);

  const setVar = (c, k, v) => setCards((list) => { const next = [...list]; while (next.length < cardCount) next.push({}); next[c] = { ...next[c], [k]: v }; return next; });
  const send = async () => {
    setBusy(true); setErr('');
    const list = Array.from({ length: cardCount }, (_, i) => cards[i] || {});
    try {
      const r = await api.post('/rcs/send', { audience, ids, templateId: tplId, ...(tpl.rcsType === 'RICHCASOUREL' ? { cards: list } : { variables: list[0] }), buttonUrl, imageUrl });
      setBatch(r.data); onSent && onSent();
    } catch (e) { setErr(errOf(e, 'Not sent.')); } finally { setBusy(false); }
  };
  const first = check && check.firstName ? check.firstName : '';
  const firstWord = first.split(/\s+/)[0];
  const left = check ? check.people.filter((p) => p.code !== 'ok') : [];
  const ready = tpl && check && check.canSend > 0 && !check.bulkLocked && blanks.every((k) => Array.from({ length: cardCount }, (_, i) => (cards[i] || {})[k]).every((v) => String(v || '').trim()));

  return (
    <Modal title={`Send RCS to ${ids.length} ${audience === 'employees' ? (ids.length === 1 ? 'employee' : 'employees') : (ids.length === 1 ? 'candidate' : 'candidates')}`} onClose={onClose} size="wide"
      footer={batch ? <button type="button" className="btn btn-primary" onClick={onClose}>Close</button> : <><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={!ready || busy} onClick={send}>{busy ? 'Sending…' : `Send to ${check ? check.canSend : 0}`}</button></>}>
      {batch ? (
        <div>
          <div className="notice green" style={{ display: 'block' }}>{batch.queued} message{batch.queued === 1 ? '' : 's'} went to the RCS queue{batch.leftOut ? `, ${batch.leftOut} left out` : ''}.</div>
          {progress && <div className="cm-help" style={{ marginTop: 8 }}>{progress.status === 'done' ? 'Finished' : progress.status === 'paused' ? 'PAUSED (no RCS credit; an Admin resumes it)' : 'Sending'}: {Object.entries(progress.counts).map(([k, v]) => `${v} ${k}`).join(' · ')}{progress.lastError ? ` · ${progress.lastError}` : ''}</div>}
          {progress && progress.failed && progress.failed.length > 0 && <ul className="sp-list">{progress.failed.map((f, i) => <li key={i}>{f.personName || 'Someone'}: {f.errorText}</li>)}</ul>}
          <div className="cm-help">&quot;Sent&quot; means rcssms.in took it. &quot;Delivered&quot; comes only from rcssms.in&apos;s report (Integrations &gt; RCS &gt; Message log).</div>
        </div>
      ) : (
        <>
          <div className="sp-field">
            <label>Template</label>
            {tpls && tpls.length === 0 ? <div className="cm-help">No approved RCS template for {MODULE[audience]} yet. An Admin adds them in Administration &gt; Integrations &gt; RCS &gt; Templates.</div> : (
              <Combo value={tplId} onChange={(e) => { setTplId(e.target.value); setCards([{}]); }}>
                <option value="">Choose a template…</option>
                {(tpls || []).map((t) => <option key={t.id} value={t.id}>{t.name} ({t.rcsType === 'RICHCASOUREL' ? 'Carousel' : t.rcsType === 'RICH' ? 'Rich card' : 'Basic'})</option>)}
              </Combo>
            )}
          </div>
          {tpl && (
            <>
              {Array.from({ length: cardCount }, (_, c) => (
                <div key={c}>
                  {cardCount > 1 && <h4 className="sp-h4">Card {c + 1}</h4>}
                  <div className="cm-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
                    {blanks.map((k, i) => (
                      <div className="sp-field" key={k}><label>Blank {i + 1}</label><input value={(cards[c] || {})[k] || ''} onChange={(e) => setVar(c, k, e.target.value)} placeholder={i === 0 ? 'e.g. {firstName}' : ''} /></div>
                    ))}
                  </div>
                </div>
              ))}
              {blanks.length > 0 && <div className="cm-help">Type {'{firstName}'} or {'{name}'} to put each person&apos;s own name.</div>}
              {tpl.hasButtonLink && <div className="sp-field"><label>Button link</label><input value={buttonUrl} onChange={(e) => setButtonUrl(e.target.value)} placeholder="https://" /></div>}
              {tpl.hasImageLink && tpl.rcsType === 'RICH' && <div className="sp-field"><label>Card image link</label><input value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="https://" /></div>}
              <h4 className="sp-h4">Preview{first ? ` (for ${first})` : ''}</h4>
              {Array.from({ length: cardCount }, (_, c) => <div key={c} className="sp-preview">{previewOf(tpl, cards[c] || {}, firstWord, first)}</div>)}
              {tpl.promotional && <div className="cm-help">Promotional: only people who gave consent get it.</div>}
            </>
          )}
          {check && (
            <div style={{ marginTop: 8 }}>
              <div className={`notice ${check.canSend ? 'green' : 'orange'}`} style={{ display: 'block' }}>{check.canSend} of {check.selected} can get it{left.length ? `; ${left.length} left out (below)` : ''}.</div>
              {check.bulkLocked && <div className="notice orange" style={{ display: 'block', marginTop: 6 }}>Sending to many is locked until an Admin&apos;s single test RCS is accepted (Integrations &gt; RCS &gt; Test send). You can send to one person now.</div>}
              {left.length > 0 && <ul className="sp-list">{left.slice(0, 30).map((p) => <li key={p.id}>{p.name || 'Someone'}{p.number ? ` (${p.number})` : ''}: {p.reason}</li>)}{left.length > 30 && <li>and {left.length - 30} more</li>}</ul>}
            </div>
          )}
          {err && <div className="error-text">{err}</div>}
        </>
      )}
    </Modal>
  );
}
