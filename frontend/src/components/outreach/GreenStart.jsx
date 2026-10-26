import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import api from '../../api';
import './greenstart.css';
import { resolveGreenStartUrl } from './greenStartLink.js';

// ---------------------------------------------------------------------------
// OMNI-CHANNEL = the founder's own Green Start product, AS IT IS (green-start-app/, source unchanged), opened inside the TeamLink window.
// It runs as its own app on its own address (http://<this host>:5190, the "gate" in green-start-app/run/gate.mjs). The gate only lets in a
// browser that holds the signed cookie that POST /api/omni-gs/session sets for a signed-in TeamLink login that may open it.
// 2026-10-22: the TeamLink backend now STARTS and looks after Green Start by itself (utils/greenStartSupervisor.js). This page shows the state
// (Running / Starting step n of 5 / Waiting for memory / Waiting for Redis / Crashed + Stopped, Off ...), says exactly what to do next, and gives
// Admins the buttons Start, Stop, Restart, Show log, Backup now. When everything is up the frame opens by itself. Shown by OmniEntry.jsx.
// ---------------------------------------------------------------------------
const gsOrigin = (port) => {
  const forced = import.meta.env && import.meta.env.VITE_GREENSTART_ORIGIN;
  if (forced) return String(forced).replace(/\/+$/, '');
  // the live site (*.teamlinks.in): Green Start has its own address; the frame shows it inside TeamLink, and the same address also opens on its own
  const live = resolveGreenStartUrl({ envUrl: import.meta.env && import.meta.env.VITE_GREENSTART_URL, hostname: window.location.hostname });
  if (live) return live.replace(/\/+$/, '');
  return `${window.location.protocol}//${window.location.hostname}:${port || 5190}`;
};

const PART_ORDER = ['db', 'redis', 'api', 'worker', 'gate'];
const PART_WORDS = { db: 'Database', redis: 'Redis (message queue)', api: 'Green Start server', worker: 'Campaign sender', gate: 'Entrance' };
const STATE_CLASS = { running: 'ok', starting: 'wait', restarting: 'wait', stopped: 'no', crashed: 'bad', missing: 'bad', unusable: 'bad' };
const STATE_WORDS = { running: 'running', starting: 'starting…', restarting: 'restarting…', stopped: 'not running', crashed: 'stopped (gave up)', missing: 'not installed', unusable: 'blocked' };

function Cmd({ text }) {
  const [done, setDone] = useState(false);
  const copy = () => {
    try { navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 2000); }); } catch { /* the text can still be selected by hand */ }
  };
  return (
    <div className="gs-cmd">
      <code>{text}</code>
      <button type="button" className="gs-copy" onClick={copy}>{done ? 'Copied' : 'Copy'}</button>
    </div>
  );
}

function Parts({ st }) {
  const rows = PART_ORDER.map((k) => {
    if (st.parts && st.parts[k]) {
      const p = st.parts[k];
      let word = STATE_WORDS[p.state] || p.state;
      if (k === 'redis' && p.state === 'missing') word = 'not installed';
      if (k === 'worker' && !p.ok && !(st.parts.redis && st.parts.redis.ok)) word = 'waits for Redis';
      return { k, cls: STATE_CLASS[p.state] || 'no', word: p.adopted && p.ok ? 'running (started by hand)' : word };
    }
    const ok = !!st[k === 'gate' ? 'gate' : k];
    return { k, cls: ok ? 'ok' : 'no', word: ok ? 'running' : 'not running' };
  });
  return (
    <ul className="gs-checks">
      {rows.map((r) => <li key={r.k} className={r.cls}>{PART_WORDS[r.k]}: {r.word}</li>)}
    </ul>
  );
}

function Resources({ st }) {
  const bits = [];
  if (st.ram) bits.push(`Free memory: ${st.ram.freeMB} MB (Green Start needs ${st.ram.needMB} MB to start)`);
  if (st.disk && st.disk.freeMB != null) bits.push(`Free disk: ${(st.disk.freeMB / 1024).toFixed(1)} GB`);
  if (st.contacts != null) bits.push(`Green Start has its own contacts: ${st.contacts}`);
  if (!bits.length) return null;
  return <p className="gs-small">{bits.join('  ·  ')}</p>;
}

function Advice({ st }) {
  const p = st.paths || {};
  const redisCmd = p.redisInstall || 'green-start-app\\run\\get-redis.cmd';
  const s = st.state;
  if (s === 'waiting_redis') {
    return (
      <div className="gs-redis">
        <b>Redis is missing. Do this once (about 5 minutes):</b>
        <ol>
          <li>Double-click this file, or paste the line below in the Windows search box (Win key) and press Enter:<Cmd text={redisCmd} /></li>
          <li>It shows the file and its size and waits. Press any key to download (about 5 MB, from the official GitHub page of tporadowski/redis).</li>
          <li>When it says <b>Done</b>, come back here. This page starts Green Start by itself within a minute.</li>
        </ol>
        <p className="gs-small">Already have Redis or Memurai on this computer on port 6379? Then nothing is needed: it is found by itself. {st.parts && st.parts.redis && st.parts.redis.note ? st.parts.redis.note : ''}</p>
      </div>
    );
  }
  if (s === 'waiting_memory') {
    return <p>This computer is short of memory ({st.ram ? `${st.ram.freeMB} MB free, ${st.ram.needMB} MB needed` : 'not enough free'}). Close heavy things (many browser tabs, Excel, builds), then wait. It checks again every minute{st.ram && st.ram.nextCheckInS != null ? ` (next check in ${st.ram.nextCheckInS} s)` : ''}.</p>;
  }
  if (s === 'starting') {
    return <p>Starting{st.step ? `: step ${st.step.n} of ${st.step.of}, ${st.step.label}` : ''}. The first start can take a minute or two. This page opens Green Start by itself.</p>;
  }
  if (s === 'crashed') {
    const c = st.crash || {};
    return (
      <div>
        <p><b>{c.label || 'A part'} keeps stopping, so it was left alone.</b> Last messages (private details are hidden):</p>
        <pre className="gs-log">{(c.lines && c.lines.length ? c.lines : [c.message || 'No message was saved.']).join('\n')}</pre>
        <p>{st.canControl ? 'Press Show log to read more, then Restart.' : 'Ask an Admin to open this page, press Show log and Restart.'}</p>
      </div>
    );
  }
  if (s === 'stopped') return <p>Green Start was stopped by an Admin. It stays stopped until an Admin presses Start.</p>;
  if (s === 'autostart_off') return <p>Auto-start is switched off on this server (<code>GREENSTART_AUTOSTART=false</code>). {st.canControl ? 'Press Start to run it now.' : 'Ask an Admin to press Start.'}</p>;
  if (s === 'partial') return <p>Some parts are running and some are not. {st.canControl ? 'Press Restart.' : 'Ask an Admin to press Restart.'}</p>;
  if (s === 'managed_elsewhere') return <p>Another TeamLink server window is already looking after Green Start{st.supervisor && st.supervisor.holderPid ? ` (process ${st.supervisor.holderPid})` : ''}. Use that one, or close it.</p>;
  if (s === 'not_built') {
    return (
      <div>
        <p>Green Start is not ready on this computer yet:</p>
        <ul>{(st.problems || []).map((x) => <li key={x}>{x}</li>)}</ul>
        <p>Run once: <Cmd text={p.launcher || 'green-start-app\\run\\start-green-start.cmd'} /></p>
      </div>
    );
  }
  if (s === 'stopping') return <p>Stopping Green Start…</p>;
  return null;
}

const HELP = [
  ['How it opens', 'Green Start starts by itself when TeamLink starts. Click Omni-Channel in the left menu. When it is ready this page opens it.'],
  ['Second login', 'Green Start has its own login (separate from TeamLink). The demo accounts are written in green-start-app\\gs-api\\README.md, section "Seeded accounts".'],
  ['Waiting for Redis', 'Run get-redis.cmd once (the card above shows the exact path).'],
  ['Waiting for memory', 'Close heavy apps. It tries again every minute.'],
  ['Crashed', 'An Admin presses Show log, then Restart.'],
  ['Do not', 'Do not press "Connect with Facebook" inside Green Start for the company WhatsApp number. TeamLink already uses that webhook.'],
];

// The look of the page, from a status object. Pure: the mock page and the real page both use it.
export function GreenStartView({ st, err, busy, ready, onCheck, onAction, onLog, log, logPart, note, frameSlot, srcUrl }) {
  const [help, setHelp] = useState(false);
  const [manage, setManage] = useState(false);

  let banner = null;
  if (err) banner = <div className="bc-err" role="alert">{err}</div>;
  else if (!st) banner = <div className="oc-note">Loading…</div>;
  else if (!st.enabled) {
    banner = (
      <div className="gs-state" role="status">
        <b>Green Start is switched off on this server</b>
        <p>An Admin switches it on by removing <code>GREENSTART_ENABLED=false</code> from the backend settings.</p>
      </div>
    );
  } else if (st.external && !(st.gate && st.api)) {
    // live server: Green Start is a separate service (GREENSTART_SUPERVISE=false); TeamLink only looks, it does not start anything
    banner = (
      <div className="gs-state" role="status">
        <b>{st.stateText || 'Green Start runs as a separate service on this server'}</b>
        <p>It is not answering right now. Ask the person who looks after the server to check the Green Start service.</p>
        <Parts st={st} />
        <button type="button" className="gs-btn" onClick={onCheck} disabled={busy}>{busy ? 'Checking…' : 'Check again'}</button>
      </div>
    );
  } else if (st.supervised === false && !(st.gate && st.api)) {
    // the TeamLink server is not looking after it (sandbox or old setup): the old hand-start message
    banner = (
      <div className="gs-state" role="status">
        <b>Green Start is not started on this computer</b>
        <p>Double-click <code>start-green-start.cmd</code> in the <code>green-start-app\run</code> folder. This page opens it by itself within 15 seconds.</p>
        <Parts st={st} />
        <button type="button" className="gs-btn" onClick={onCheck} disabled={busy}>{busy ? 'Checking…' : 'Check again'}</button>
      </div>
    );
  } else if (!ready) {
    const cls = { crashed: 'gs-bad', waiting_redis: 'gs-wait', waiting_memory: 'gs-wait' }[st.state] || '';
    banner = (
      <div className={`gs-state ${cls}`} role="status">
        <div className="gs-head"><b>Green Start: {st.stateText}</b>{st.step && st.state === 'starting' ? <span className="gs-step">Step {st.step.n} of {st.step.of}</span> : null}</div>
        <Advice st={st} />
        <Parts st={st} />
        <Resources st={st} />
        <div className="gs-actions">
          <button type="button" className="gs-btn" onClick={onCheck} disabled={busy}>{busy ? 'Checking…' : 'Check again'}</button>
          {st.canControl && <Controls st={st} onAction={onAction} onLog={onLog} />}
        </div>
      </div>
    );
  }

  return (
    <div className="gs-wrap">
      <div className="gs-bar">
        <span className="gs-title">Green Start</span>
        <span className="oc-note">Your own app for WhatsApp, SMS and email campaigns, with its own contacts. It opens already signed in to the company account.</span>
        <span className="gs-links">
          {ready && st && st.canControl && <button type="button" className="gs-link gs-linkbtn" onClick={() => setManage((v) => !v)}>{manage ? 'Hide manage' : 'Manage'}</button>}
          <button type="button" className="gs-link gs-linkbtn" onClick={() => setHelp((v) => !v)}>{help ? 'Hide help' : 'Help'}</button>
          {ready && <a className="gs-link" href={srcUrl} target="_blank" rel="noopener noreferrer">Open in a full tab</a>}
        </span>
      </div>
      {help && (
        <div className="gs-help">
          <dl>{HELP.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
          <p className="gs-small">Full guide: <code>{(st && st.paths && st.paths.support) || 'green-start-app\\run\\README-SUPPORT.md'}</code> (copy on the Desktop: <code>TeamLink-OmniChannel-Support.md</code>)</p>
        </div>
      )}
      {note && <div className="oc-note" role="status">{note}</div>}
      {banner}
      {ready && manage && st && (
        <div className="gs-state">
          <Parts st={st} />
          <Resources st={st} />
          <div className="gs-actions"><Controls st={st} onAction={onAction} onLog={onLog} /></div>
          <SsoAccount />
        </div>
      )}
      {log && (
        <div className="gs-state">
          <b>Log: {logPart}</b>
          <pre className="gs-log">{log.length ? log.join('\n') : 'The log is empty.'}</pre>
        </div>
      )}
      {st && st.canControl && st.backups && (manage || !ready) && (
        <p className="gs-small">Backups: {st.backups.count} kept (newest 7), last {st.backups.lastAt ? new Date(st.backups.lastAt).toLocaleString() : 'none yet'}. Folder: <code>{st.backups.dir}</code>{st.backups.lastError ? ` · ${st.backups.lastError}` : ''}</p>
      )}
      {frameSlot}
    </div>
  );
}

// Admin: which Green Start account everybody opens with (no login page). Empty = Green Start's own login page.
function SsoAccount() {
  const [v, setV] = useState(null);
  const [email, setEmail] = useState('');
  const [msg, setMsg] = useState('');
  useEffect(() => { api.get('/omni-gs/sso-settings').then((r) => { setV(r.data); setEmail(r.data.email || ''); }).catch(() => setV(false)); }, []);
  if (v === null || v === false) return null;
  const save = async () => {
    try { const r = await api.put('/omni-gs/sso-settings', { email }); setMsg(r.data.email ? `Saved. Everybody opens Green Start as ${r.data.email}.` : 'Saved. Green Start shows its own login page.'); } catch (e) { setMsg((e.response && e.response.data && e.response.data.error) || 'Could not save.'); }
  };
  return (
    <div className="gs-small" style={{ marginTop: 10 }}>
      <b>Open without the login page.</b> Company Green Start account (email):{' '}
      <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="admin@yourcompany.com" style={{ minWidth: 240 }} />{' '}
      <button type="button" className="gs-btn gs-btn2" onClick={save}>Save</button>
      {!v.secretSet && <div>One-click sign-in is not switched on on this server yet (GREENSTART_SSO_SECRET), so the login page still shows.</div>}
      {msg && <div role="status">{msg}</div>}
    </div>
  );
}

function Controls({ st, onAction, onLog }) {
  const running = st.state === 'running' || st.state === 'partial';
  const [part, setPart] = useState('');
  const pick = part || (st.crash && st.crash.part && st.crash.part !== 'prepare' ? st.crash.part : 'supervisor');
  return (
    <>
      <button type="button" className="gs-btn" onClick={() => onAction('start')} disabled={st.state === 'stopping'}>Start Green Start</button>
      <button type="button" className="gs-btn gs-btn2" onClick={() => onAction('stop')} disabled={st.state === 'stopping' || st.state === 'stopped'}>Stop</button>
      <button type="button" className="gs-btn gs-btn2" onClick={() => onAction('restart')} disabled={st.state === 'stopping'}>Restart</button>
      <span className="gs-logpick">
        <select value={pick} onChange={(e) => setPart(e.target.value)} aria-label="Which log">
          <option value="supervisor">Supervisor</option>
          {PART_ORDER.map((k) => <option key={k} value={k}>{PART_WORDS[k]}</option>)}
          <option value="migrate">Database updates</option>
        </select>
        <button type="button" className="gs-btn gs-btn2" onClick={() => onLog(pick)}>Show log</button>
      </span>
      <button type="button" className="gs-btn gs-btn2" onClick={() => onAction('backup')} disabled={!st.parts || !st.parts.db.ok}>Backup now</button>
      {running && <span className="gs-small">Stop closes the database cleanly; your data stays.</span>}
    </>
  );
}

export default function GreenStart() {
  const [st, setSt] = useState(null); // status from /api/omni-gs/status
  const [err, setErr] = useState('');
  const [ready, setReady] = useState(false); // session cookie set, safe to open the frame
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [log, setLog] = useState(null);
  const [logPart, setLogPart] = useState('');
  const frame = useRef(null);
  const [h, setH] = useState(720);

  const check = useCallback(async () => {
    setBusy(true);
    try {
      const r = await api.get('/omni-gs/status');
      setSt(r.data); setErr('');
      // on the live site Green Start is a separate service (external): its web files are not in TeamLink's folder, so "built" does not apply
      if (r.data.enabled && (r.data.built || r.data.external) && r.data.gate && r.data.api) {
        await api.post('/omni-gs/session');
        setReady(true);
      } else setReady(false);
    } catch (e) {
      setErr((e.response && e.response.data && e.response.data.error) || 'Green Start could not be checked.');
    } finally { setBusy(false); }
  }, []);

  const act = useCallback(async (action) => {
    setNote(''); setLog(null);
    try {
      const r = await api.post(`/omni-gs/${action}`);
      setNote(r.data.message || (r.data.file ? `Backup saved: ${r.data.file}` : 'Done.'));
    } catch (e) {
      setNote((e.response && e.response.data && e.response.data.error) || 'That did not work.');
    }
    setTimeout(check, 2500);
  }, [check]);

  const showLog = useCallback(async (part) => {
    setNote('');
    try {
      const r = await api.get('/omni-gs/log', { params: { part, lines: 80 } });
      setLog(r.data.lines || []); setLogPart(PART_WORDS[part] || part);
    } catch (e) {
      setNote((e.response && e.response.data && e.response.data.error) || 'The log could not be read.');
    }
  }, []);

  useEffect(() => { check(); }, [check]);
  // while it is not running, look again every 15 seconds so it opens by itself once started
  useEffect(() => {
    if (ready) return undefined;
    const t = setInterval(check, 15000);
    return () => clearInterval(t);
  }, [ready, check]);
  // the pass is good for 2 hours: renew it every 30 minutes while this page is open
  useEffect(() => {
    if (!ready) return undefined;
    const t = setInterval(() => { api.post('/omni-gs/session').catch(() => {}); }, 30 * 60 * 1000);
    return () => clearInterval(t);
  }, [ready]);

  // fill the rest of the page: no second scrollbar
  useLayoutEffect(() => {
    const fit = () => {
      const top = frame.current ? frame.current.getBoundingClientRect().top : 160;
      setH(Math.max(480, window.innerHeight - top - 6));
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [ready, st]);

  // NO LOGIN PAGE (founder 2026-10-26): when the server has one-click sign-in set up, the frame opens Green Start already signed in to
  // the company account (a single-use 60 s ticket from POST /api/omni-gs/sso-ticket). Not set up = Green Start's own login, as before.
  const [sso, setSso] = useState(undefined); // undefined = asking, null = not set up, string = the signed-in link
  useEffect(() => {
    if (!ready || sso !== undefined) return;
    api.post('/omni-gs/sso-ticket').then((r) => {
      const t = r.data && r.data.ticket;
      setSso(t ? `${gsOrigin(st && st.port)}/auth/teamlink#ticket=${encodeURIComponent(t)}&next=${encodeURIComponent(r.data.next || '/app')}` : null);
    }).catch(() => setSso(null));
  }, [ready]); // eslint-disable-line react-hooks/exhaustive-deps
  const loginUrl = `${gsOrigin(st && st.port)}/login`; // the product signs you in here (and goes on to its dashboard if you already are)
  const src = sso || loginUrl;
  const frameSlot = ready && sso !== undefined ? (
    <iframe
      ref={frame}
      title="Green Start"
      src={src}
      className="gs-frame"
      style={{ height: h }}
      allow="clipboard-write; microphone; autoplay"
    />
  ) : null;

  return <GreenStartView st={st} err={err} busy={busy} ready={ready} onCheck={check} onAction={act} onLog={showLog} log={log} logPart={logPart} note={note} frameSlot={frameSlot} srcUrl={loginUrl} />;
}
