// GST & TDS PORTALS (Accounts spec 1) — sits between the Expenses & Bills
// table and GST Reconciliation on Office & Expenses.
//
// Two compact areas, GST and TDS, each with its registration number, the
// portal User ID and password, Save, Show / Hide and Open portal.
//
// SECURITY — what this screen does and does not do:
//   * GSTIN and TAN are the business profile's own fields (the same ones
//     Business & Tax Details shows) — saved through the API, not copied.
//   * The password is never in the page source, localStorage, sessionStorage
//     or the console. A read (GET /office-expenses/tax-portals) says only
//     whether one is saved. "Show" asks POST …/reveal for it explicitly; the
//     answer lives in this component's React state until Hide, a 30-second
//     timer, or leaving the page — whichever comes first.
//   * A blank password box on Save keeps the saved password.
//   * "Open portal" is a plain link to the official site in a new tab
//     (noopener). Nothing is ever typed into, or submitted to, the portal.
import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../../api';
import { checkGstin, isTan, clean } from '../../utils/gstin';
import { fmtD } from './officeUtil';
import './taxportals.css';

const REVEAL_MS = 30000;

const AREAS = [
  {
    key: 'gst',
    title: 'GST Portal',
    idField: 'gstin',
    idLabel: 'GSTIN',
    idMax: 15,
    idPlaceholder: '15 characters, e.g. 36AAAAA0000A1Z5',
    userLabel: 'GST Portal User ID',
    passLabel: 'GST Portal Password',
    save: 'Save GST Details',
    open: 'Open GST Portal',
    url: 'https://www.gst.gov.in/',
    site: 'gst.gov.in',
  },
  {
    key: 'tds',
    title: 'TDS Portal',
    idField: 'tan',
    idLabel: 'TAN',
    idMax: 10,
    idPlaceholder: 'e.g. HYDT12345A',
    userLabel: 'TDS Portal User ID',
    passLabel: 'TDS Portal Password',
    save: 'Save TDS Details',
    open: 'Open TDS Portal',
    // TRACES — the TDS Reconciliation Analysis and Correction Enabling System
    // of the Income Tax Department (Form 16A, TDS statements and corrections).
    url: 'https://www.tdscpc.gov.in/',
    site: 'tdscpc.gov.in (TRACES)',
  },
];

function idProblem(area, v) {
  if (!v) return '';
  if (area.idField === 'gstin') {
    const c = checkGstin(v);
    return c.ok ? '' : c.error;
  }
  return isTan(v) ? '' : 'TAN is 4 letters, 5 digits and a letter';
}

function PortalArea({ area, data, keyConfigured, onSaved }) {
  const [idValue, setIdValue] = useState(data.idValue || '');
  const [userId, setUserId] = useState(data.userId || '');
  // The box holds either a NEW password being typed (dirty) or, after Show,
  // the saved one (not dirty). Only a dirty value is ever sent on Save.
  const [pw, setPw] = useState('');
  const [pwDirty, setPwDirty] = useState(false);
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const timer = useRef(null);
  const pwDirtyRef = useRef(false);
  useEffect(() => { pwDirtyRef.current = pwDirty; }, [pwDirty]);

  const clearTimer = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  // Forget a revealed password: back to masked, and out of state. A new
  // password still being typed is only masked, not thrown away.
  const hide = useCallback(() => {
    clearTimer();
    setShown(false);
    setPw((cur) => (pwDirtyRef.current ? cur : ''));
  }, []);
  useEffect(() => () => clearTimer(), []);

  // A fresh answer from the server (after a save) resets the boxes.
  useEffect(() => {
    setIdValue(data.idValue || '');
    setUserId(data.userId || '');
  }, [data.idValue, data.userId]);

  const idBad = idProblem(area, idValue);

  const toggleShow = async () => {
    setErr(''); setOk('');
    if (shown) { hide(); return; }
    // A password being typed is shown as it is — no server call.
    if (pwDirty || !data.hasPassword) { setShown(true); return; }
    setBusy('reveal');
    try {
      const r = await api.post(`/office-expenses/tax-portals/${area.key}/reveal`);
      setPw(r.data.password || '');
      setShown(true);
      clearTimer();
      timer.current = setTimeout(hide, REVEAL_MS);
    } catch (e) {
      setErr(e.response?.data?.error || 'The password could not be shown.');
    }
    setBusy('');
  };

  const save = async (e) => {
    e.preventDefault();
    setErr(''); setOk('');
    if (idBad) { setErr(`${area.idLabel}: ${idBad}`); return; }
    if (pwDirty && pw && !keyConfigured) { setErr('The server has no encryption key, so a password cannot be saved yet.'); return; }
    setBusy('save');
    try {
      const body = { [area.idField]: idValue, userId };
      if (pwDirty && pw) body.password = pw;
      const r = await api.put(`/office-expenses/tax-portals/${area.key}`, body);
      clearTimer();
      setPw(''); setPwDirty(false); setShown(false);
      setOk(`${area.title} details saved.`);
      onSaved(r.data, area.idField, idValue !== (data.idValue || ''));
    } catch (e2) {
      setErr(e2.response?.data?.error || 'The details could not be saved.');
    }
    setBusy('');
  };

  const removePassword = async () => {
    if (!window.confirm(`Remove the saved ${area.title} password? The User ID and ${area.idLabel} stay.`)) return;
    setErr(''); setOk('');
    setBusy('save');
    try {
      const r = await api.put(`/office-expenses/tax-portals/${area.key}`, { clearPassword: true });
      clearTimer();
      setPw(''); setPwDirty(false); setShown(false);
      setOk('The saved password was removed.');
      onSaved(r.data, area.idField, false);
    } catch (e2) {
      setErr(e2.response?.data?.error || 'The password could not be removed.');
    }
    setBusy('');
  };

  const pwPlaceholder = data.hasPassword ? `${data.passwordHint} saved — leave blank to keep it` : 'Not saved yet';
  const fid = (k) => `tp-${area.key}-${k}`;

  return (
    <form className="tp-area" onSubmit={save} autoComplete="off">
      <div className="tp-hd">
        <b>{area.title}</b>
        <span className="small-muted">
          {data.updatedAt ? `Saved ${fmtD(String(data.updatedAt).slice(0, 10))}${data.updatedBy ? ` by ${data.updatedBy}` : ''}` : 'No login saved yet'}
        </span>
      </div>

      <label className="field" htmlFor={fid('id')}><span>{area.idLabel}</span>
        <input
          id={fid('id')}
          aria-label={area.idLabel}
          value={idValue}
          maxLength={area.idMax}
          placeholder={area.idPlaceholder}
          spellCheck={false}
          onChange={(e) => setIdValue(clean(e.target.value))}
        />
        {idBad ? <div className="oe-hint bad">{idBad}</div>
          : <div className="oe-hint">The business profile&apos;s {area.idLabel} — the same one Business &amp; Tax Details shows.</div>}
      </label>

      <label className="field" htmlFor={fid('user')}><span>{area.userLabel}</span>
        <input
          id={fid('user')}
          aria-label={area.userLabel}
          value={userId}
          maxLength={120}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setUserId(e.target.value)}
        />
      </label>

      <div className="field">
        <label htmlFor={fid('pw')}><span>{area.passLabel}</span></label>
        <div className="tp-pw">
          <input
            id={fid('pw')}
            aria-label={area.passLabel}
            type={shown ? 'text' : 'password'}
            value={pw}
            maxLength={200}
            autoComplete="new-password"
            spellCheck={false}
            disabled={!keyConfigured}
            placeholder={keyConfigured ? pwPlaceholder : 'Needs the server encryption key'}
            onChange={(e) => { setPw(e.target.value); setPwDirty(true); }}
          />
          <button
            type="button"
            className="btn btn-sm"
            onClick={toggleShow}
            disabled={busy === 'reveal' || (!data.hasPassword && !pw)}
            aria-pressed={shown}
            aria-controls={fid('pw')}
          >
            {busy === 'reveal' ? '…' : shown ? 'Hide' : 'Show'}
          </button>
        </div>
        <div className="oe-hint">
          {shown && !pwDirty ? 'Shown for 30 seconds, then masked again.' : 'Kept encrypted on the server. A blank box keeps the saved password.'}
          {data.hasPassword && (
            <> <button type="button" className="link-btn" onClick={removePassword} disabled={!!busy}>Remove saved password</button></>
          )}
        </div>
      </div>

      {err && <div className="notice red tp-msg"><span>{err}</span></div>}
      {ok && <div className="notice tp-msg"><span>{ok}</span></div>}

      <div className="tp-acts">
        <button type="submit" className="btn btn-primary btn-sm" disabled={!!busy || !!idBad}>
          {busy === 'save' ? 'Saving…' : area.save}
        </button>
        <a className="btn btn-sm" href={area.url} target="_blank" rel="noopener noreferrer" title={`Opens ${area.url} in a new tab — you sign in there yourself`}>
          ↗ {area.open}
        </a>
        <span className="small-muted tp-site">{area.site}</span>
      </div>
    </form>
  );
}

export default function TaxPortals({ onProfileSaved }) {
  const [data, setData] = useState(null);
  const [loadErr, setLoadErr] = useState('');

  useEffect(() => {
    let live = true;
    api.get('/office-expenses/tax-portals')
      .then((r) => { if (live) setData(r.data); })
      .catch((e) => { if (live) setLoadErr(e.response?.data?.error || 'The portal details could not be loaded.'); });
    return () => { live = false; };
  }, []);

  if (loadErr) return <div className="notice red"><span>{loadErr}</span></div>;
  if (!data) return <div className="small-muted"><span className="oe-spin oe-spin-sm" aria-hidden="true" /> Loading…</div>;

  const saved = (next, _field, idChanged) => {
    setData(next);
    // A new GSTIN / TAN is the business profile's — refresh the sections that show it.
    if (idChanged && onProfileSaved) onProfileSaved();
  };

  return (
    <div className="tp-wrap">
      {!data.keyConfigured && (
        <div className="notice amber tp-msg">
          <span>{data.noKeyMessage || 'The server has no encryption key, so portal passwords cannot be saved yet.'} GSTIN, TAN and User IDs can still be saved.</span>
        </div>
      )}
      <div className="tp-grid">
        {AREAS.map((a) => (
          <PortalArea key={a.key} area={a} data={data[a.key]} keyConfigured={data.keyConfigured} onSaved={saved} />
        ))}
      </div>
      <div className="small-muted tp-note">
        Only Admin and Accounts logins that can edit Office &amp; Expenses see this card. Every Show is written to the Audit Log (who and
        when — never the password). The portals ask for their own sign-in and CAPTCHA; this app never signs in or submits anything for you.
      </div>
    </div>
  );
}
