import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../../api';
import TokenPicker from '../messaging/TokenPicker.jsx';
import './offerLetter.css';

// ---------------------------------------------------------------------------
// ADMINISTRATION -> COMPANY SETUP -> MESSAGE TEMPLATES -> "Offer letter"
//
// The offer letter that is emailed to a new TeamLink joiner together with the joining date: the wording (editable), the
// "send it by itself" switch, and a live preview of the letter exactly as the candidate gets it (the same HTML that goes in
// the mail; the PDF attachment is made from the same words). Only an Admin changes it; everybody else may look.
// (backend: utils/offerLetterMail.js, /api/ats/offer-letter-mail/...)
// ---------------------------------------------------------------------------
const clone = (o) => JSON.parse(JSON.stringify(o));
const errText = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d;

// set a value at a path such as 'terms.2.text' on a copy of the template
function setPath(obj, path, value) {
  const next = clone(obj);
  const keys = path.split('.');
  let at = next;
  keys.slice(0, -1).forEach((k) => { at = at[k]; });
  at[keys[keys.length - 1]] = value;
  return next;
}

export default function OfferLetterEditor() {
  const [data, setData] = useState(null);
  const [t, setT] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState({ html: '', omitted: [], error: '' });
  const focused = useRef(null); // { el, path } the box the cursor was last in (for "Add a detail")
  const edit = !!(data && data.canEdit);

  const apply = useCallback((d) => { setData(d); setT(clone(d.template)); setDirty(false); }, []);
  // The server restarts for about two minutes every time an update is installed (502 / 503 / 504 or no answer at all). The letter
  // is not broken then, so the screen waits and asks again by itself (up to 24 times, 5 s apart) before it gives up, and then
  // offers "Try again" instead of a dead end.
  const [attempt, setAttempt] = useState(0);
  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    let stop = false;
    let timer = null;
    const load = (n) => api.get('/ats/offer-letter-mail/template')
      .then((r) => { if (!stop) { setErr(''); setWaiting(false); apply(r.data); } })
      .catch((e) => {
        if (stop) return;
        const status = e && e.response && e.response.status;
        const restarting = !status || [502, 503, 504].includes(status);
        if (restarting && n < 24) {
          setWaiting(true);
          setErr('TeamLink is restarting for an update. Trying again in a moment…');
          timer = setTimeout(() => load(n + 1), 5000);
          return;
        }
        setWaiting(false);
        setErr(restarting ? 'TeamLink is not answering right now (an update may be installing).' : errText(e, 'Could not load the offer letter.'));
      });
    load(0);
    return () => { stop = true; if (timer) clearTimeout(timer); };
  }, [apply, attempt]);

  // live preview: the unsaved words, with sample details, a moment after the last key press
  useEffect(() => {
    if (!t || !edit) return undefined;
    const h = setTimeout(() => {
      api.post('/ats/offer-letter-mail/template/preview', t)
        .then((r) => setPreview({ html: r.data.html, omitted: r.data.omitted || [], error: '' }))
        .catch((e) => setPreview((p) => ({ ...p, error: errText(e, 'The preview could not be made.') })));
    }, 450);
    return () => clearTimeout(h);
  }, [t, edit]);
  const set = (path, value) => { setT((cur) => setPath(cur, path, value)); setDirty(true); setMsg(''); };
  const field = (path, props = {}) => ({
    value: path.split('.').reduce((a, k) => (a == null ? a : a[k]), t) ?? '',
    disabled: !edit,
    'data-path': path,
    onFocus: (e) => { focused.current = { el: e.target, path }; },
    onChange: (e) => set(path, e.target.value),
    ...props,
  });
  const pick = (key) => {
    const f = focused.current;
    if (!f || !f.el || !document.body.contains(f.el)) { setMsg('Click inside a box first, then pick the detail.'); return; }
    const el = f.el;
    const cur = el.value || '';
    const a = el.selectionStart == null ? cur.length : el.selectionStart;
    const b = el.selectionEnd == null ? a : el.selectionEnd;
    const piece = `{{${key}}}`;
    set(f.path, `${cur.slice(0, a)}${piece}${cur.slice(b)}`);
    setTimeout(() => { try { el.focus(); el.setSelectionRange(a + piece.length, a + piece.length); } catch { /* ignore */ } }, 0);
  };

  async function save() {
    setBusy(true); setErr(''); setMsg('');
    try { const r = await api.put('/ats/offer-letter-mail/template', t); apply(r.data); setMsg(r.data.message || 'Saved.'); } catch (e) { setErr(errText(e, 'Could not save.')); } finally { setBusy(false); }
  }
  async function reset() {
    if (!window.confirm('Go back to the starting words? Your changes to the letter will be lost.')) return;
    setBusy(true); setErr(''); setMsg('');
    try { const r = await api.post('/ats/offer-letter-mail/template/reset'); apply(r.data); setMsg(r.data.message || 'Done.'); } catch (e) { setErr(errText(e, 'Could not reset.')); } finally { setBusy(false); }
  }
  async function toggleAuto(on) {
    if (dirty && !window.confirm('You have words that are not saved yet. The switch works on the SAVED words. Continue?')) return;
    setBusy(true); setErr(''); setMsg('');
    try { const r = await api.put('/ats/offer-letter-mail/automatic', { enabled: on }); setData((d) => ({ ...d, enabled: r.data.enabled, masterOn: r.data.masterOn })); setMsg(r.data.message || 'Saved.'); } catch (e) { setErr(errText(e, 'Could not change the switch.')); } finally { setBusy(false); }
  }
  const move = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= t.terms.length) return;
    const terms = clone(t.terms); [terms[i], terms[j]] = [terms[j], terms[i]];
    set('terms', terms);
  };

  if (!t) {
    return (
      <div className="card">
        {err ? <span className={waiting ? 'small-muted' : 'error-text'}>{err}</span> : 'Loading…'}
        {err && !waiting && <> <button type="button" className="btn btn-sm" onClick={() => { setErr(''); setAttempt((a) => a + 1); }}>Try again</button></>}
      </div>
    );
  }
  const tokens = (data.tokens || []).map((x) => ({ ...x, group: 'Details from the record' }));

  return (
    <div className="olm">
      <div className="card section olm-switch">
        <div className="olm-switch-row">
          <label className="olm-big">
            <input type="checkbox" checked={!!data.enabled} disabled={!edit || busy} onChange={(e) => toggleAuto(e.target.checked)} />
            <span><b>Send the offer letter by itself</b> when a TeamLink new joiner gets their joining date</span>
          </label>
          <span className={`status ${data.enabled ? 'active' : ''}`}>{data.enabled ? 'ON' : 'OFF'}</span>
        </div>
        <div className="small-muted" style={{ marginTop: 6 }}>
          One mail to the candidate, once for each joining: the letter is inside the mail and also attached as a PDF. It goes when HR sets the joining date, with the first joining reminder, or with a
          “Joining confirmation” message. Changing the joining date later sends nothing more. A person can always press <b>Send offer letter</b> (or <b>Send again</b>) on the Joining screen.
          It is only for TeamLink&apos;s own new employees. For a client&apos;s job the client makes the letter.
        </div>
        {!data.enabled && <div className="notice amber" style={{ marginTop: 10, marginBottom: 0 }}>It is OFF. Read the letter on the right, change the words you want, press Save, and then switch this on.</div>}
        {data.enabled && !data.masterOn && (
          <div className="notice amber" style={{ marginTop: 10, marginBottom: 0 }}>
            The master switch <b>Candidate emails</b> is OFF (Administration &rarr; Company Setup &rarr; Step timing). While it is off, the letter is held and the Joining screen says so; a person can still press Send.
          </div>
        )}
        {data.enabled && data.masterOn && <div className="small-muted" style={{ marginTop: 8 }}>The master switch <b>Candidate emails</b> is ON, so the letters go out.</div>}
        {data.updatedByName && <div className="small-muted" style={{ marginTop: 6 }}>Wording last saved by {data.updatedByName}{data.updatedAt ? ` · ${new Date(data.updatedAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}` : ''}.</div>}
      </div>

      {err && <div className="error-text" style={{ marginBottom: 8 }}>{err}</div>}
      {msg && <div className="notice" style={{ marginBottom: 12 }}>{msg}</div>}

      <div className="olm-cols">
        <div className="olm-form">
          {!edit && <div className="notice amber">Only an Admin can change the offer letter. You can read it here.</div>}
          <div className="card section">
            <h3 className="olm-h">1. The email</h3>
            <div className="field"><label>Subject</label><input type="text" {...field('subject')} /></div>
            <div className="field"><label>Words above the letter (the covering note)</label><textarea rows="7" {...field('coverNote')} /></div>
          </div>

          <div className="card section">
            <h3 className="olm-h">2. The letter</h3>
            <div className="field"><label>Title</label><input type="text" {...field('title')} /></div>
            <div className="field"><label>Opening paragraph</label><textarea rows="5" {...field('intro')} /></div>
            <div className="grid-2">
              <div className="field"><label>Trainee stipend per month (₹) <span className="small-muted">- during the trainee period</span></label><input type="text" inputMode="numeric" {...field('monthlySalary')} placeholder="10000" /></div>
              <div className="field"><label>Trainee period (months) <span className="small-muted">- 1 to 12</span></label><input type="text" inputMode="numeric" {...field('traineeMonths')} placeholder="6" /></div>
              <div className="field"><label>Trainee period for Team Leads (months) <span className="small-muted">- used when the position is Team Lead / TL</span></label><input type="text" inputMode="numeric" {...field('traineeMonthsLead')} placeholder="3" /></div>
              <div className="field"><label>Annual CTC on confirmation (₹) <span className="small-muted">- empty = this line is left out</span></label><input type="text" inputMode="numeric" {...field('confirmedCtc')} placeholder="300000" /></div>
              <div className="field"><label>Working hours <span className="small-muted">- empty = this line is left out</span></label><input type="text" {...field('workingHours')} placeholder="e.g. 9:00 am to 6:00 pm, Monday to Saturday" /></div>
            </div>
            <div className="field"><label className="olm-check"><input type="checkbox" checked={t.showCtc !== false} disabled={!edit} onChange={(e) => set('showCtc', e.target.checked)} /> Print the stipend and the CTC in the letter</label></div>

            <div className="olm-sub">Details table <span className="small-muted">(a row is left out when the record has no value for it)</span></div>
            {t.details.map((r, i) => (
              <div className="olm-row" key={`d${i}`}>
                <input type="text" {...field(`details.${i}.label`)} placeholder="Label" aria-label="Row label" />
                <input type="text" {...field(`details.${i}.value`)} placeholder="Value" aria-label="Row value" />
                {edit && <button type="button" className="btn btn-sm btn-ghost" title="Remove this row" onClick={() => set('details', t.details.filter((_, k) => k !== i))}>✕</button>}
              </div>
            ))}
            {edit && t.details.length < (data.limits.maxDetails || 12) && <button type="button" className="btn btn-sm" onClick={() => set('details', [...t.details, { label: '', value: '' }])}>＋ Add a row</button>}

            <div className="olm-sub" style={{ marginTop: 16 }}>Terms <span className="small-muted">(numbered in the letter; a heading prints with a colon after it, e.g. “Date of Appointment:”; a term written on several lines prints as a list)</span></div>
            <div className="field"><label>Heading over the numbered points <span className="small-muted">- empty = no heading</span></label><input type="text" {...field('termsHeading')} placeholder="e.g. Terms of employment" /></div>
            {t.terms.map((r, i) => (
              <div className="olm-term" key={`t${i}`}>
                <div className="olm-term-head">
                  <input type="text" {...field(`terms.${i}.title`)} placeholder="Heading, e.g. Probation" aria-label="Term heading" />
                  {edit && (
                    <span className="olm-term-btns">
                      <button type="button" className="btn btn-sm btn-ghost" title="Move up" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                      <button type="button" className="btn btn-sm btn-ghost" title="Move down" disabled={i === t.terms.length - 1} onClick={() => move(i, 1)}>↓</button>
                      <button type="button" className="btn btn-sm btn-ghost" title="Remove this term" onClick={() => set('terms', t.terms.filter((_, k) => k !== i))}>✕</button>
                    </span>
                  )}
                </div>
                <textarea rows="3" {...field(`terms.${i}.text`)} aria-label="Term text" />
              </div>
            ))}
            {edit && t.terms.length < (data.limits.maxTerms || 20) && <button type="button" className="btn btn-sm" onClick={() => set('terms', [...t.terms, { title: '', text: '' }])}>＋ Add a term</button>}

            <div className="field" style={{ marginTop: 16 }}><label>Closing line</label><textarea rows="2" {...field('closing')} /></div>
          </div>

          <div className="card section">
            <h3 className="olm-h">3. Signature and acceptance</h3>
            <div className="grid-2">
              <div className="field"><label>Signed by (name) <span className="small-muted">- leave empty to print only the title</span></label><input type="text" {...field('signatoryName')} placeholder="e.g. the name of the person who signs" /></div>
              <div className="field"><label>Title under the signature</label><input type="text" {...field('signatoryTitle')} /></div>
            </div>
            <div className="field"><label>Acceptance line (the box at the end)</label><textarea rows="2" {...field('acceptanceLine')} /></div>
            <div className="field"><label>Small print at the foot of every page</label><input type="text" {...field('footerNote')} /></div>
          </div>

          {edit && (
            <div className="olm-actions">
              <button type="button" className="btn btn-primary" disabled={busy || !dirty} onClick={save}>{busy ? 'Saving…' : 'Save the offer letter'}</button>
              <button type="button" className="btn" disabled={busy} onClick={reset}>Back to the starting words</button>
              {dirty && <span className="small-muted">You have changes that are not saved.</span>}
            </div>
          )}
        </div>

        <div className="olm-side">
          {edit && (
            <div className="card section olm-tokens">
              <div className="olm-sub">Details filled in from the record</div>
              <div className="small-muted" style={{ marginBottom: 8 }}>Click inside a box on the left, then pick a detail to drop it in (it shows as {'{{name}}'}).</div>
              <TokenPicker tokens={tokens} onPick={pick} startOpen />
            </div>
          )}
          <div className="card section">
            <div className="olm-sub">How the candidate gets it <span className="small-muted">(sample details; the PDF is made from the same words)</span></div>
            {preview.error && <div className="error-text">{preview.error}</div>}
            {preview.omitted.length > 0 && <div className="small-muted">Left out in this sample: {preview.omitted.join('; ')}.</div>}
            {edit
              ? <iframe className="olm-frame" title="Offer letter preview" sandbox="" srcDoc={preview.html || '<p style="font-family:sans-serif;color:#666;padding:20px">Making the preview…</p>'} />
              : <div className="small-muted">The preview is shown to an Admin. To read the letter for one person, open that person on the Joining screen and press Offer letter.</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
