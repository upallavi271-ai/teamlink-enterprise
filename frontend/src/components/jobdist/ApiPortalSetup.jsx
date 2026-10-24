import { useCallback, useEffect, useState } from 'react';
import { jp, jpError, isNotMigrated, TEST_TONE, when } from '../jobpublish/jpKit.js';
import { PortalChip } from '../jobpublish/PublishChips.jsx';
import { dx } from './distKit.js';
import '../jobpublish/jobpublish.css';
import './jobdist.css';

// ---------------------------------------------------------------------------
// SET UP TELEGRAM / FACEBOOK (plain words). One card, used in two places:
//   * Administration > Integrations > Job portals (an Admin: save / replace / delete, switch ON / OFF, test, closing note)
//   * the Distribute tab of a job, when nothing is saved yet (a team lead / client manager may save the FIRST details and test)
// The token is typed once and never shown again. "Test connection" only READS (nothing is posted). "Send a test post" is a
// separate button and works only while an Admin has switched the channel ON.
// <ApiPortalSetup portal="telegram" isAdmin canPoster onChanged />
// ---------------------------------------------------------------------------
const TEXT = {
  telegram: {
    name: 'Telegram channel',
    steps: [
      'In Telegram open @BotFather and send /newbot. Follow the questions. It gives you a TOKEN: a long line like 123456789:AAH... Keep it private.',
      'Open your channel (or make one). Add your new bot as an ADMINISTRATOR who is allowed to post messages.',
      'Type the channel name below (like @myjobs) and paste the token. Press Save.',
      'Press Test connection. It only checks the bot and the channel. Nothing is posted.',
      'An Admin switches it ON. Then press Send a test post to see one real message in the channel.',
    ],
    doc: 'docs/job-publishing/TELEGRAM.md',
  },
  facebook: {
    name: 'Facebook page',
    steps: [
      'On developers.facebook.com make an app and add the Pages permissions. Posting needs the permission pages_manage_posts. Meta must approve the app (App Review) unless only the Page admins use it.',
      'Make a Page access token for your Page (Graph API Explorer, or the app dashboard). Use a long-lived token.',
      'Type the Page number (Page ID) below and paste the token. Press Save.',
      'Press Test connection. It only reads the Page name. Nothing is posted.',
      'An Admin switches it ON. Then press Send a test post to see one real post on the Page.',
    ],
    doc: 'docs/job-publishing/FACEBOOK.md',
  },
};

export default function ApiPortalSetup({
  portal, isAdmin = false, canPoster = false, onChanged = null, compact = false,
}) {
  const t = TEXT[portal];
  const [cred, setCred] = useState(null);
  const [settings, setSettings] = useState(null);
  const [notOn, setNotOn] = useState(false);
  const [form, setForm] = useState({ username: '', password: '' });
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [result, setResult] = useState(null);
  const [open, setOpen] = useState(!compact);

  const load = useCallback(async () => {
    try {
      if (isAdmin) {
        const [c, s] = await Promise.all([jp.get('/credentials'), dx.get('/settings').catch(() => null)]);
        setCred((c.credentials || []).find((x) => x.portal === portal) || null);
        setSettings(s && s.settings);
      } else {
        const c = await jp.get(`/credentials/${portal}/status`);
        setCred(c.credential || null);
      }
      setNotOn(false);
    } catch (e) { if (isNotMigrated(e)) setNotOn(true); else setErr(jpError(e)); }
  }, [portal, isAdmin]);
  useEffect(() => { load(); }, [load]);

  const flash = (m) => { setMsg(m); setErr(''); };
  async function go(key, fn, ok) {
    setBusy(key); setErr(''); setMsg('');
    try { const out = await fn(); if (ok) flash(ok); await load(); if (onChanged) onChanged(); return out; } catch (e) { setErr(jpError(e)); return null; } finally { setBusy(''); }
  }
  if (!t) return null;
  if (notOn) return <div className="jp-note">Job publishing is not switched on yet.</div>;
  const c = cred || {};
  const f = c.fields || { username: portal === 'telegram' ? 'Channel' : 'Page number (Page ID)', usernameHint: '', password: portal === 'telegram' ? 'Bot token' : 'Page access token', passwordHint: '' };
  const hasLogin = !!c.hasLogin;
  const lt = c.lastTest && c.lastTest.state && c.lastTest.state !== 'NOT_TESTED' ? c.lastTest : null;
  const canSave = isAdmin || (canPoster && !hasLogin);
  const typed = !!(form.username.trim() || form.password);

  const save = (e) => {
    e.preventDefault();
    if (!form.username.trim() && !form.password) { setErr(`Type the ${f.username.toLowerCase()} and the ${f.password.toLowerCase()}.`); return; }
    go('save', () => jp.put(`/credentials/${portal}`, { username: form.username.trim(), password: form.password.trim() }), 'Saved. The token is hidden from now on.').then((o) => { if (o) setForm({ username: '', password: '' }); });
  };
  const test = async () => {
    setResult(null);
    const out = await go('test', () => jp.post(`/credentials/${portal}/verify`), '');
    if (out && out.result) setResult(out.result);
  };
  const testPost = async () => {
    if (!window.confirm(`This sends ONE real test message to your ${t.name}. You can delete it there afterwards. Send it?`)) return;
    setBusy('tp'); setErr(''); setMsg(''); setResult(null);
    try {
      const out = await jp.post(`/credentials/${portal}/test-post`);
      if (out.error) setErr(out.error); else flash(out.summary || 'A test message was sent.');
    } catch (e) { setErr(jpError(e)); } finally { setBusy(''); }
  };
  const sw = (on) => {
    if (on && !window.confirm(`Switch ON ${t.name}?\n\nA team lead or client manager can then post jobs to it for real. Start with "Check only (dry run)" on a requirement first.`)) return;
    go('sw', () => jp.post(`/credentials/${portal}/switch`, { enabled: on }), `${t.name} is switched ${on ? 'ON' : 'OFF'}.`);
  };
  const del = () => {
    if (!window.confirm(`Delete the saved ${t.name} details? Posting there stops (the switch goes OFF).`)) return;
    go('del', () => jp.del(`/credentials/${portal}`), 'Deleted.');
  };
  const note = (on) => go('note', () => dx.put('/settings', { closingNote: { [portal]: on } }), on ? 'A short closing note will be posted when a requirement is closed.' : 'Nothing is posted when a requirement is closed.');

  return (
    <section className="jp-card jp-wrap" aria-label={t.name}>
      <div className="jp-row">
        <h3 style={{ margin: 0 }}>{t.name}</h3>
        <span className="jp-spacer" />
        <PortalChip state={hasLogin ? { label: 'Details saved', tone: 'green', icon: '✔' } : { label: 'Not set up', tone: 'grey', icon: '○' }} />
        <PortalChip state={c.enabled ? { label: 'ON', tone: 'green', icon: '✔' } : { label: 'OFF', tone: 'grey', icon: '○' }} label="Posting" />
        {compact && <button type="button" className="btn btn-sm" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Set up'}</button>}
      </div>
      {open && (
        <>
          <p className="jp-note" style={{ margin: 0 }}>Posts for free through the official {portal === 'telegram' ? 'Telegram Bot' : 'Facebook Graph'} API. Nothing is sent until an Admin switches it ON, and every post can be checked first with a dry run.</p>
          {c.secretsConfigured === false && <div className="jp-err" role="alert">The server has no secret key yet, so details cannot be saved safely. Ask the team that looks after TeamLink.</div>}
          {c.killed && <div className="jp-note">Posting here is stopped by the big stop switch.</div>}
          {lt && <div><PortalChip state={{ label: lt.words, tone: TEST_TONE[lt.state] || 'grey', icon: '●' }} label="Last test" />{lt.reason ? <span className="jp-note"> {lt.reason}</span> : null}{lt.at ? <span className="jp-note"> {when(lt.at)}</span> : null}</div>}
          {isAdmin && hasLogin && <div className="jp-note">Saved: <b>{c.usernameMasked || 'yes'}</b> · token saved (never shown)</div>}
          <details className="dx-setup" open={!hasLogin}>
            <summary style={{ cursor: 'pointer', fontWeight: 700 }}>How to set this up</summary>
            <ol>{t.steps.map((s) => <li key={s}>{s}</li>)}</ol>
            <span className="jp-note">The same steps with pictures of each screen: <span className="jp-code">{t.doc}</span></span>
          </details>
          {canSave && (
            <form onSubmit={save} className="jp-row" style={{ alignItems: 'flex-end' }}>
              <label className="jp-field">{f.username}
                <input type="text" autoComplete="off" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder={hasLogin ? 'Leave empty to keep' : f.usernameHint} />
              </label>
              <label className="jp-field">{f.password}
                <input type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder={hasLogin ? 'Leave empty to keep' : f.passwordHint} />
              </label>
              <button type="submit" className="btn btn-primary" disabled={busy === 'save' || !typed}>{hasLogin ? 'Save new details' : 'Save'}</button>
            </form>
          )}
          {!canSave && hasLogin && !isAdmin && <div className="jp-note">The details are saved. Only an Admin can change or delete them.</div>}
          {!canSave && !hasLogin && <div className="jp-note">Not set up yet. Ask an Admin or your team lead to set it up.</div>}
          <div className="jp-row">
            {(isAdmin || canPoster) && <button type="button" className="btn" disabled={!hasLogin || busy === 'test'} onClick={test} title="Only reads. Nothing is posted.">{busy === 'test' ? 'Checking...' : 'Test connection'}</button>}
            {(isAdmin || canPoster) && <button type="button" className="btn" disabled={!hasLogin || !c.enabled || busy === 'tp'} onClick={testPost} title={c.enabled ? 'Sends one real test message' : 'Works after an Admin switches posting ON'}>Send a test post to my {portal === 'telegram' ? 'channel' : 'page'}</button>}
            {isAdmin && (c.enabled
              ? <button type="button" className="btn" disabled={busy === 'sw'} onClick={() => sw(false)}>Switch OFF</button>
              : <button type="button" className="btn btn-primary" disabled={!hasLogin || c.status === 'FAILED' || busy === 'sw'} onClick={() => sw(true)}>Switch ON</button>)}
            {isAdmin && hasLogin && <button type="button" className="btn btn-sm btn-danger" disabled={busy === 'del'} onClick={del}>Delete details</button>}
          </div>
          <p className="jp-note" style={{ margin: 0 }}>Test connection only reads. &quot;Send a test post&quot; is a separate button and posts ONE real message (only while posting is ON).</p>
          {result && (
            <div className={result.ok ? 'jp-ok' : 'jp-err'} role="status">
              <b>{result.ok ? 'Connected' : (result.words || 'Not working')}</b>{result.summary ? `: ${result.summary}` : ''}{result.apiStatus ? ` (the site answered ${result.apiStatus})` : ''}
            </div>
          )}
          {isAdmin && settings && (
            <label className="jp-row" style={{ fontSize: 13 }}>
              <input type="checkbox" checked={!!(settings.closingNote && settings.closingNote[portal])} onChange={(e) => note(e.target.checked)} disabled={busy === 'note'} style={{ width: 18, height: 18 }} />
              <span>When a requirement is closed, post a short &quot;This job is now closed&quot; note (OFF means nothing is sent)</span>
            </label>
          )}
        </>
      )}
      <div role="status" aria-live="polite">{msg && <div className="jp-ok">{msg}</div>}</div>
      {err && <div className="jp-err" role="alert">{err}</div>}
    </section>
  );
}
