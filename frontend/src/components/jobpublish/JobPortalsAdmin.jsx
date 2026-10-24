import { useCallback, useEffect, useRef, useState } from 'react';
import JpModal from './JpModal.jsx';
import { ScreenshotButton } from './PostingLogs.jsx';
import { PortalChip } from './PublishChips.jsx';
import PublishDiagnostics from './PublishDiagnostics.jsx';
import NeedsHelp from './NeedsHelp.jsx';
import ApiPortalSetup from '../jobdist/ApiPortalSetup.jsx';
import DistPlatformsAdmin from '../jobdist/DistPlatformsAdmin.jsx';
import {
  PORTALS, jp, jpError, isNotMigrated, NOT_ON_WORDS, portalName, useVisiblePoll, when, checkLoginFormat, TEST_TONE,
} from './jpKit.js';
import './jobpublish.css';
import Combo from '../Combo.jsx';

// ---------------------------------------------------------------------------
// ADMINISTRATION > INTEGRATIONS > "Job portals"  (Super Admin and Admin only; the server says 403 to anyone else).
//   Logins: one card per site: masked login, connection chip, Save login (the password is never shown again),
//           Test connection (progress + result + picture), ON/OFF with a risk confirm, limits, Resume, the 6 steps.
//   Mappings: what the portal's form calls each of our values (inline edit, Reset to default).
//   Top: the big stop switch.
// ---------------------------------------------------------------------------
const CONN = {
  CONNECTED: ['Connected', 'green'], FAILED: ['Failed', 'red'], NEEDS_HUMAN: ['Needs login', 'yellow'], UNVERIFIED: ['Not verified', 'grey'], DISABLED: ['Off', 'grey'],
};
const ICON = { green: '✔', blue: '⟳', yellow: '!', red: '✖', grey: '○' };
const STEPS = [
  'Save the company login here.',
  'Sign in yourself once on the computer that runs the posting helper (command below). You type the password and solve any code. We never do.',
  'Press Test connection.',
  'Switch the site on.',
  'Send one requirement as a Dry run (nothing is posted). Look at the picture.',
  'If the picture is right, publish one real requirement and check it on the site.',
];

function Verify({ portal, entryId, workerRunning, onDone }) {
  const [row, setRow] = useState(null);
  const [shot, setShot] = useState(null);
  const done = row && ['SUCCEEDED', 'FAILED', 'NEEDS_HUMAN', 'DEAD', 'CANCELLED'].includes(row.status);
  const look = useCallback(async () => {
    try {
      const q = await jp.get('/queue', { portal, pageSize: 10 });
      const r = (q.rows || []).find((x) => x.id === entryId);
      if (r) {
        setRow(r);
        if (['SUCCEEDED', 'FAILED', 'NEEDS_HUMAN', 'DEAD', 'CANCELLED'].includes(r.status)) {
          const l = await jp.get('/logs', { queue: entryId, pageSize: 20 });
          const s = (l.rows || []).find((x) => x.hasScreenshot);
          setShot(s ? s.id : null);
          onDone && onDone();
        }
      }
    } catch { /* keep waiting */ }
  }, [portal, entryId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { look(); }, [look]);
  useVisiblePoll(look, !done, 5000);
  const status = row ? row.status : 'QUEUED';
  const helping = !!(row && row.waiting);
  const words = helping ? ['Needs your help: type the OTP below', 'yellow'] : { QUEUED: ['Waiting for the posting helper', 'blue'], RUNNING: ['Checking the login now', 'blue'], SUCCEEDED: ['The login works', 'green'], FAILED: ['The login did not work', 'red'], NEEDS_HUMAN: ['A person must sign in (code or CAPTCHA)', 'yellow'], DEAD: ['The check gave up', 'red'], CANCELLED: ['Cancelled', 'grey'] }[status] || [status, 'grey'];
  return (
    <div className="jp-card" aria-live="polite">
      <div className="jp-row">
        <PortalChip state={{ label: words[0], tone: words[1], icon: ICON[words[1]] }} />
        {shot && <ScreenshotButton logId={shot} label="See the picture" />}
      </div>
      {row && (row.waiting || (row.status === 'NEEDS_HUMAN' && row.help)) && <NeedsHelp item={row} name={portalName(portal)} canPost onChanged={look} />}
      {!done && workerRunning === false && <p className="jp-note">The posting helper is not running, so this check waits. Start it with <span className="jp-code">npm run posting-worker</span>.</p>}
      {row && row.errorMessage && <p className="jp-note">{row.errorMessage}</p>}
    </div>
  );
}

function RiskConfirm({ name, onYes, onNo }) {
  const [ok, setOk] = useState(false);
  return (
    <JpModal title={`Switch on ${name}?`} size="is-small" onClose={onNo} foot={(
      <>
        <button type="button" className="btn" onClick={onNo}>No, keep it off</button>
        <button type="button" className="btn btn-danger" disabled={!ok} onClick={onYes}>Switch on</button>
      </>
    )}
    >
      <p style={{ marginTop: 0 }}><b>Please read this.</b></p>
      <p className="jp-note" style={{ fontSize: 13.5 }}>
        This lets TeamLink sign in to {name} with the company login and post jobs by itself, like a person would.
        The rules of job sites usually do not allow this. {name} can block or ban the company account, and you can lose the account and its paid plans.
        We stay slow and gentle, and we stop when the site asks for a code or a CAPTCHA, but the risk is still yours.
      </p>
      <p className="jp-note" style={{ fontSize: 13.5 }}>Start with a Dry run (nothing is posted) before you publish a real requirement.</p>
      <label className="jp-opts" style={{ border: 0, margin: 0, padding: 0 }}>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 600 }}><input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} /> I understand</span>
      </label>
    </JpModal>
  );
}

function PortalCard({ meta, cred, info, workerRunning, realOk, reload, flash }) {
  const [form, setForm] = useState({ username: '', password: '' });
  const [lim, setLim] = useState({ dailyLimit: '', hourlyLimit: '', minGapSeconds: '' });
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [verify, setVerify] = useState(null);
  const [risk, setRisk] = useState(false);
  const [help, setHelp] = useState(false);
  useEffect(() => { if (cred) setLim({ dailyLimit: cred.dailyLimit ?? '', hourlyLimit: cred.hourlyLimit ?? '', minGapSeconds: cred.minGapSeconds ?? '' }); }, [cred]);
  const manual = meta.kind === 'manual';
  const internal = meta.kind === 'internal';
  const c = cred || {};
  const [cw, ct] = !c.hasLogin ? ['No login saved', 'grey'] : (CONN[c.status] || ['Not verified', 'grey']);
  const hold = c.status === 'NEEDS_HUMAN' || !!c.humanHold;
  const typed = !!(form.username.trim() || form.password);
  const fmt = checkLoginFormat(meta.name, form, !c.hasLogin);
  const lt = c.lastTest && c.lastTest.state && c.lastTest.state !== 'NOT_TESTED' ? c.lastTest : null;
  const cfg = info && info.settings;

  async function go(key, fn, ok) {
    setBusy(key); setErr('');
    try { const out = await fn(); if (ok) flash(ok); await reload(); return out; } catch (e) { setErr(jpError(e)); return null; } finally { setBusy(''); }
  }
  const save = (e) => {
    e.preventDefault();
    if (!form.username.trim() && !form.password) { setErr('Type the login name or the password.'); return; }
    if (fmt.problems.length) { setErr(fmt.problems.join(' ')); return; }
    go('save', () => jp.put(`/credentials/${meta.key}`, { username: form.username.trim(), password: form.password }), 'Login saved. The password is hidden from now on.').then((o) => { if (o) setForm({ username: '', password: '' }); });
  };
  const saveLimits = (e) => {
    e.preventDefault();
    const num = (v) => (v === '' || v == null ? '-' : Number(v));
    go('lim', () => jp.put(`/credentials/${meta.key}`, { dailyLimit: num(lim.dailyLimit), hourlyLimit: num(lim.hourlyLimit), minGapSeconds: num(lim.minGapSeconds) }), 'Limits saved.');
  };
  const test = async () => {
    const out = await go('test', () => jp.post(`/credentials/${meta.key}/verify`), '');
    if (out && out.entry) setVerify(out.entry.id);
  };

  return (
    <section className="jp-card jp-wrap" aria-label={meta.name}>
      <div className="jp-row">
        <h3 style={{ margin: 0 }}>{meta.name}</h3>
        <span className="jp-spacer" />
        {!manual && !internal && <PortalChip state={{ label: cw, tone: ct, icon: ICON[ct] }} label="Login" />}
        {!manual && !internal && cfg && <PortalChip state={cfg.verified ? { label: 'Verified', tone: 'green', icon: ICON.green } : { label: 'UNVERIFIED', tone: 'yellow', icon: ICON.yellow }} label="Page settings" />}
        {!manual && !internal && <PortalChip state={c.enabled ? { label: 'ON', tone: 'green', icon: ICON.green } : { label: 'OFF', tone: 'grey', icon: ICON.grey }} label="Automatic posting" />}
      </div>
      {manual && <p className="jp-note">LinkedIn is posted by hand only. No login is stored. When a requirement is sent here we make a task and the text to copy.</p>}
      {internal && <p className="jp-note">Our own careers page. It needs no login and no browser. It goes live at once when a requirement is sent here.</p>}
      {!manual && !internal && (
        <>
          <div className="jp-note" aria-label="Saved login">
            {c.hasLogin ? <>Login: <b>{c.usernameMasked || 'saved'}</b>{c.hasPassword ? ' · password saved (never shown)' : ' · no password yet'}</> : 'No login saved yet.'}
            {c.lastVerifiedAt ? ` · last checked ${when(c.lastVerifiedAt)}` : ''}
          </div>
          {lt && <div><PortalChip state={{ label: lt.words, tone: TEST_TONE[lt.state] || 'grey', icon: ICON[TEST_TONE[lt.state] || 'grey'] }} label="Last test" />{lt.reason ? <span className="jp-note"> {lt.reason}</span> : null}{lt.at ? <span className="jp-note"> {when(lt.at)}</span> : null}</div>}
          {cfg && !cfg.verified && <div className="jp-note">The page settings for {meta.name} are <b>unverified</b>: written from the public look of the site, not yet checked on the real one. A Dry run works; a REAL post is refused until a person calibrates them (docs/job-publishing/CALIBRATION.md).</div>}
          {realOk === false && <div className="jp-note">Real posting is switched off on this server (it needs <span className="jp-code">TL_ALLOW_REAL_POSTING=1</span> set by whoever runs the server). Test connection and Dry run still work.</div>}
          {c.lastError && <div className="jp-err" role="alert">{c.lastError}</div>}
          {c.secretsConfigured === false && <div className="jp-err" role="alert">The server has no secret key yet, so logins cannot be saved safely. Ask the team that looks after TeamLink.</div>}
          {(c.killed || c.paused) && <div className="jp-note">Posting here is {c.killed ? 'stopped by the big stop switch' : 'paused'}.</div>}
          <form onSubmit={save} className="jp-row" style={{ alignItems: 'flex-end' }}>
            <label className="jp-field">Login name or email
              <input type="text" autoComplete="off" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder={c.hasLogin ? 'Leave empty to keep' : ''} />
            </label>
            <label className="jp-field">Password
              <input type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder={c.hasPassword ? 'Leave empty to keep' : ''} />
            </label>
            <button type="submit" className="btn btn-primary" disabled={busy === 'save' || (typed && fmt.problems.length > 0)}>Save login</button>
          </form>
          {typed && (fmt.problems.length > 0 || fmt.warnings.length > 0) && (
            <ul className="jp-fmt" aria-live="polite">{fmt.problems.map((t) => <li key={t} className="bad">{t}</li>)}{fmt.warnings.map((t) => <li key={t} className="warn">{t}</li>)}</ul>
          )}
          <div className="jp-row">
            <button type="button" className="btn" disabled={!c.hasLogin || busy === 'test'} onClick={test}>Test connection</button>
            {!c.enabled
              ? <button type="button" className="btn" disabled={!c.hasLogin || c.status === 'FAILED' || busy === 'sw'} onClick={() => setRisk(true)}>Switch on</button>
              : <button type="button" className="btn" disabled={busy === 'sw'} onClick={() => go('sw', () => jp.post(`/credentials/${meta.key}/switch`, { enabled: false }), `${meta.name} is switched off.`)}>Switch off</button>}
            {hold && <button type="button" className="btn btn-primary" disabled={busy === 'res'} onClick={() => go('res', () => jp.post(`/portals/${meta.key}/resume`), `${meta.name} can post again.`)}>Resume this portal</button>}
            {c.hasLogin && <button type="button" className="btn btn-danger btn-sm" disabled={busy === 'del'} onClick={() => { if (window.confirm(`Remove the saved login for ${meta.name}? It also switches the site off.`)) go('del', () => jp.del(`/credentials/${meta.key}`), 'Login removed.'); }}>Remove login</button>}
          </div>
          {hold && <div className="jp-note">This site is on hold: it asked for a code or a CAPTCHA. Sign in yourself (steps below), then press Resume this portal.</div>}
          {verify && <Verify portal={meta.key} entryId={verify} workerRunning={workerRunning} onDone={reload} />}
          <form onSubmit={saveLimits} className="jp-row" style={{ alignItems: 'flex-end' }}>
            <label className="jp-field">Most per day<input type="number" min="1" value={lim.dailyLimit} onChange={(e) => setLim({ ...lim, dailyLimit: e.target.value })} placeholder="Normal" /></label>
            <label className="jp-field">Most per hour<input type="number" min="1" value={lim.hourlyLimit} onChange={(e) => setLim({ ...lim, hourlyLimit: e.target.value })} placeholder="Normal" /></label>
            <label className="jp-field">Wait between requirements (seconds)<input type="number" min="5" value={lim.minGapSeconds} onChange={(e) => setLim({ ...lim, minGapSeconds: e.target.value })} placeholder="Normal" /></label>
            <button type="submit" className="btn btn-sm" disabled={busy === 'lim'}>Save limits</button>
          </form>
          <div>
            <button type="button" className="btn btn-sm btn-ghost" aria-expanded={help} onClick={() => setHelp(!help)}>{help ? 'Hide' : 'Show'}: how to open the portal session yourself</button>
            {help && (
              <div className="jp-note" style={{ marginTop: 6 }}>
                <p style={{ margin: '0 0 6px' }}>On the computer that runs the posting helper, type this command. A Chrome window opens on {meta.name}. You sign in yourself. Close the window when you are in.</p>
                <p><span className="jp-code">npm run portal-session -- {meta.key}</span></p>
                <ol className="jp-steps">{STEPS.map((s) => <li key={s}>{s}</li>)}</ol>
              </div>
            )}
          </div>
        </>
      )}
      {err && <div className="jp-err" role="alert">{err}</div>}
      {risk && <RiskConfirm name={meta.name} onNo={() => setRisk(false)} onYes={() => { setRisk(false); go('sw', () => jp.post(`/credentials/${meta.key}/switch`, { enabled: true }), `${meta.name} is switched on. Do a Dry run first.`); }} />}
    </section>
  );
}

// ---- mappings
function Mappings() {
  const [portal, setPortal] = useState('naukri');
  const [field, setField] = useState('');
  const [data, setData] = useState(null);
  const [edit, setEdit] = useState({});
  const [add, setAdd] = useState({ atsValue: '', portalValue: '', portalCode: '' });
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const load = useCallback(() => jp.get('/mappings', { portal, field: field || undefined }).then((d) => { setData(d); setEdit({}); setErr(''); }).catch((e) => setErr(jpError(e, 'Could not read the word list.'))), [portal, field]);
  useEffect(() => { load(); }, [load]);
  const fields = (data && data.fields) || [];
  const FIELD_WORDS = { employmentType: 'Job type', workMode: 'Work mode', experience: 'Experience', salary: 'Pay', location: 'City', industry: 'Industry', functionalArea: 'Department / area' };
  const rows = (data && data.rows) || [];
  async function put(list, ok) {
    setErr(''); setMsg('');
    try { await jp.put('/mappings', { rows: list }); setMsg(ok); await load(); } catch (e) { setErr(jpError(e)); }
  }
  const base = (r) => ({ portal: r.portal, field: r.field, atsValue: r.atsValue });
  return (
    <div className="jp-wrap">
      <p className="jp-note" style={{ margin: 0 }}>Each site calls things by its own words. Change a word here if a site shows the wrong one. A word with no match is sent as it is.</p>
      <div className="jp-filters">
        <Combo aria-label="Site" value={portal} onChange={(e) => setPortal(e.target.value)}>{PORTALS.filter((p) => p.kind === 'browser' || p.kind === 'internal').map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}</Combo>
        <Combo aria-label="What" value={field} onChange={(e) => setField(e.target.value)}>
          <option value="">Everything</option>
          {fields.map((x) => <option key={x} value={x}>{FIELD_WORDS[x] || x}</option>)}
        </Combo>
        <button type="button" className="btn btn-sm btn-danger" disabled={!rows.some((r) => r.origin === 'admin')} onClick={() => { if (window.confirm(`Put every word you changed for ${portalName(portal)} back to the TeamLink default?`)) put(rows.filter((r) => r.origin === 'admin').map((r) => ({ ...base(r), delete: true })), 'Back to the defaults.'); }}>Reset to defaults</button>
      </div>
      {err && <div className="jp-err" role="alert">{err}</div>}
      <div role="status" aria-live="polite">{msg && <div className="jp-ok">{msg}</div>}</div>
      {!data && !err && <div className="jp-note" role="status">Loading...</div>}
      {data && rows.length === 0 && <div className="jp-off"><b>No words here</b><span>Add one below.</span></div>}
      {rows.length > 0 && (
        <div className="tbl-wrap">
          <table className="jp-table">
            <thead><tr><th>What</th><th>Our word</th><th>The site&apos;s word</th><th>Code</th><th>Used</th><th>Do</th></tr></thead>
            <tbody>
              {rows.map((r) => {
                const e = edit[r.id] || {};
                const v = (k) => (e[k] !== undefined ? e[k] : r[k] == null ? '' : r[k]);
                const dirty = Object.keys(e).length > 0;
                const set = (k, val) => setEdit({ ...edit, [r.id]: { ...e, [k]: val } });
                return (
                  <tr key={r.id}>
                    <td data-l="What">{FIELD_WORDS[r.field] || r.field}</td>
                    <td data-l="Our word">{r.atsValue}</td>
                    <td data-l="The site's word"><input aria-label={`The site's word for ${r.atsValue}`} value={v('portalValue')} onChange={(x) => set('portalValue', x.target.value)} /></td>
                    <td data-l="Code"><input aria-label={`Code for ${r.atsValue}`} value={v('portalCode')} onChange={(x) => set('portalCode', x.target.value)} style={{ maxWidth: 90 }} /></td>
                    <td data-l="Used"><input type="checkbox" aria-label={`Use ${r.atsValue}`} checked={!!v('active')} onChange={(x) => set('active', x.target.checked)} /></td>
                    <td data-l="Do" className="jp-acts-cell"><span className="jp-row">
                      <button type="button" className="btn btn-sm btn-primary" disabled={!dirty} onClick={() => put([{ ...base(r), portalValue: v('portalValue'), portalCode: v('portalCode') || null, active: !!v('active') }], 'Saved.')}>Save</button>
                      {r.origin === 'admin' && <button type="button" className="btn btn-sm" onClick={() => put([{ ...base(r), delete: true }], 'Back to the default.')}>Reset</button>}
                    </span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <form className="jp-card jp-row" style={{ alignItems: 'flex-end' }} onSubmit={(e) => {
        e.preventDefault();
        if (!field) { setErr('Pick what you are adding (Job type, City...) in the second box first.'); return; }
        if (!add.atsValue.trim() || !add.portalValue.trim()) { setErr('Type our word and the site\'s word.'); return; }
        put([{ portal, field, atsValue: add.atsValue.trim(), portalValue: add.portalValue.trim(), portalCode: add.portalCode.trim() || null, active: true }], 'Added.').then(() => setAdd({ atsValue: '', portalValue: '', portalCode: '' }));
      }}
      >
        <label className="jp-field">Our word<input value={add.atsValue} onChange={(e) => setAdd({ ...add, atsValue: e.target.value })} /></label>
        <label className="jp-field">The site&apos;s word<input value={add.portalValue} onChange={(e) => setAdd({ ...add, portalValue: e.target.value })} /></label>
        <label className="jp-field">Code (if any)<input value={add.portalCode} onChange={(e) => setAdd({ ...add, portalCode: e.target.value })} style={{ maxWidth: 110 }} /></label>
        <button type="submit" className="btn">Add a word</button>
      </form>
    </div>
  );
}

export default function JobPortalsAdmin() {
  const [tab, setTab] = useState('logins');
  const [creds, setCreds] = useState(null);
  const [ports, setPorts] = useState(null);
  const [notOn, setNotOn] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const reload = useCallback(async () => {
    try {
      const [c, p] = await Promise.all([jp.get('/credentials'), jp.get('/portals')]);
      if (!live.current) return;
      setCreds(c.credentials || []); setPorts(p); setErr(''); setNotOn(false);
    } catch (e) {
      if (!live.current) return;
      if (isNotMigrated(e)) setNotOn(true); else setErr(jpError(e, 'Could not read the job portals.'));
    }
  }, []);
  useEffect(() => { reload(); }, [reload]);

  if (notOn) return <div className="jp-off" role="status"><b>Job publishing is not switched on yet</b><span>{NOT_ON_WORDS}</span></div>;
  const killAll = !!(ports && ports.killAll);
  const paused = !!(ports && ports.paused);
  const worker = ports && ports.worker;
  async function sw(body, ok) {
    setBusy(true); setErr('');
    try { await jp.put('/switches', body); setMsg(ok); await reload(); } catch (e) { setErr(jpError(e)); } finally { setBusy(false); }
  }
  return (
    <div className="jp-wrap">
      <div className="jp-card jp-wrap">
        <div className="jp-row">
          <h3 style={{ margin: 0 }}>Job portals</h3>
          <span className="jp-spacer" />
          <PortalChip state={worker && worker.running ? { label: 'Posting helper is running', tone: 'green', icon: ICON.green } : { label: 'Posting helper is not running', tone: 'yellow', icon: ICON.yellow }} />
        </div>
        <p className="jp-note" style={{ margin: 0 }}>TeamLink can post jobs to Naukri, Foundit and Shine for you, and to our own careers page. Every site starts OFF. LinkedIn is always by hand.</p>
        {!(worker && worker.running) && <p className="jp-note" style={{ margin: 0 }}>To start the helper type <span className="jp-code">npm run posting-worker</span> on the server computer.</p>}
        <div className="jp-row">
          {!killAll
            ? <button type="button" className="btn btn-danger" disabled={busy} onClick={() => { if (window.confirm('Stop ALL posting to every site right now? Requirements wait in the queue until you start it again.')) sw({ killAll: true, reason: 'Stopped from the Job portals screen' }, 'All posting is stopped.'); }}>Stop all posting now</button>
            : <button type="button" className="btn btn-primary" disabled={busy} onClick={() => sw({ killAll: false }, 'Posting can run again.')}>Start posting again</button>}
          {!paused
            ? <button type="button" className="btn" disabled={busy || killAll} onClick={() => sw({ pauseAll: true }, 'Posting is paused.')}>Pause</button>
            : <button type="button" className="btn" disabled={busy} onClick={() => sw({ pauseAll: false }, 'Posting continues.')}>Continue</button>}
          {killAll && <PortalChip state={{ label: 'Everything is stopped', tone: 'red', icon: ICON.red }} />}
          {paused && !killAll && <PortalChip state={{ label: 'Paused', tone: 'yellow', icon: ICON.yellow }} />}
        </div>
        <div role="status" aria-live="polite">{msg && <div className="jp-ok">{msg}</div>}</div>
        {err && <div className="jp-err" role="alert">{err}</div>}
      </div>
      <div className="jp-tabsub" role="tablist" aria-label="Job portals views">
        <button type="button" role="tab" aria-selected={tab === 'logins'} className={tab === 'logins' ? 'is-on' : ''} onClick={() => setTab('logins')}>Logins and switches</button>
        <button type="button" role="tab" aria-selected={tab === 'places'} className={tab === 'places' ? 'is-on' : ''} onClick={() => setTab('places')}>Where requirements are posted</button>
        <button type="button" role="tab" aria-selected={tab === 'words'} className={tab === 'words' ? 'is-on' : ''} onClick={() => setTab('words')}>Words each site uses</button>
        <button type="button" role="tab" aria-selected={tab === 'health'} className={tab === 'health' ? 'is-on' : ''} onClick={() => setTab('health')}>Health and problems</button>
      </div>
      {tab === 'logins' && !creds && !err && <div className="jp-note" role="status">Loading...</div>}
      {tab === 'logins' && creds && PORTALS.map((p) => (p.kind === 'api'
        ? <ApiPortalSetup key={p.key} portal={p.key} isAdmin onChanged={reload} />
        : <PortalCard key={p.key} meta={p} cred={creds.find((c) => c.portal === p.key)} info={ports && (ports.portals || []).find((x) => x.portal === p.key)} workerRunning={worker ? worker.running : undefined} realOk={ports ? ports.realPostingAllowed : undefined} reload={reload} flash={setMsg} />
      ))}
      {tab === 'places' && <DistPlatformsAdmin />}
      {tab === 'words' && <Mappings />}
      {tab === 'health' && <PublishDiagnostics canPost />}
    </div>
  );
}
