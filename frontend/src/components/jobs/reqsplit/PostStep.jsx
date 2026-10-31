import EditTemplateButton from '../EditTemplateButton.jsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../../../api';
import StatusChip from '../../ui/StatusChip.jsx';
import { jp, jpError, isNotMigrated } from '../../jobpublish/jpKit.js';
import JobHelp from '../../jobpublish/JobHelp.jsx';
import TemplateLibrary from '../TemplateLibrary.jsx';
import { CARDS, cardOf, cardState, buildLayout, fillTemplate, unresolved, MANUAL } from './postWizard.js';
import { Stepper, PlatformScreen, ComposeScreen, PreviewScreen, DoneScreen, HandHelp, FlowScreen, copyText } from './PostScreens.jsx';
import '../../broadcast/broadcast.css';
import './reqsplit.css';

// ---------------------------------------------------------------------------
// 2026-10-15: four-screen wizard (PostScreens.jsx, postWizard.js). Naukri -> Shine are posted BY HAND on their own recruiter pages (server state: /api/job-flow, jobFlow/).
// THE POST STEP of "Save & Post" (2026-10-13), shown INSIDE the Add / Edit job window after the job and its text are saved.
//   * the sites, each with a tick (Naukri, Foundit, Shine, Indeed, Careers page, Google Jobs, LinkedIn by hand, WhatsApp contacts)
//   * a site that posts by itself but has no saved login shows "<Site> login needed": username + password (the password is
//     masked and never shown again) -> Save and connect -> Test connection -> the post is queued by itself
//   * the per-site switch is OFF until an Admin switches it on: an Admin gets the button, everyone else is told to ask
//   * "Dry run" (check only, nothing is posted) is ON until the portal's page settings are marked verified
//   * honest chips: "Posted" only when the site says the job is live
// Servers: /api/job-publish/portals, /credentials/:portal/(status|verify|switch), PUT /credentials/:portal (first login),
//          /api/job-broadcast/jobs/:id/post-everywhere (+ post-status). Nothing here talks to a portal itself.
// ---------------------------------------------------------------------------
const PLACES = [
  ['naukri', 'Naukri', 'Posted for you with the company login'],
  ['foundit', 'Foundit', 'We post it for you with the company login'],
  ['shine', 'Shine', 'Posted for you with the company login'],
  ['indeed', 'Indeed', 'Goes into our job feed'],
  ['career', 'Our careers page', 'Live at once'],
  ['google', 'Google Jobs', 'Shows in Google job search from our job feed'],
  ['linkedin', 'LinkedIn (by hand)', 'We keep the task and the text; you post it'],
  ['telegram', 'Telegram channel', 'A short message to your channel (an Admin sets it up once)'],
  // Social media (2026-10-31): shown as their own list on the first screen. Each one posts the job through the account's official API.
  ['facebook', 'Facebook', 'A post on your Facebook Page with the apply link'],
  ['instagram', 'Instagram', 'A picture of the job with the text under it'],
  ['linkedinpost', 'LinkedIn post', 'A post on your LinkedIn feed with the apply link (the LinkedIn tile above is the by-hand job listing)'],
  ['threads', 'Threads', 'A short text post with the apply link'],
  ['whatsapp', 'WhatsApp contacts', 'Send the requirement link to one of your contact lists'],
];
const AUTO = ['naukri', 'foundit', 'shine'];
const SOCIAL = ['facebook', 'instagram', 'linkedinpost', 'threads']; // the social media list of screen 1
const API = ['telegram', ...SOCIAL]; // official API posts: no login box here (an Admin connects them in Integrations > Social Media), a dry run is always offered
const SOCIAL_TAB = { facebook: 'facebook', instagram: 'instagram', threads: 'threads', linkedinpost: 'linkedin' }; // the Social Media tab that connects each one
const TONE = { posted: 'green', feed: 'green', running: 'blue', queued: 'blue', needs_help: 'yellow', not_connected: 'yellow', not_available: 'grey', failed: 'red', idle: 'grey' };
const LABEL = { posted: 'Posted', feed: 'In our feed', running: 'Running', queued: 'Queued', needs_help: 'Needs your help', not_connected: 'Not connected', not_available: 'Not available yet', failed: 'Failed', idle: 'Not posted' };
const NAME = Object.fromEntries(PLACES.map((p) => [p[0], p[1]]));
const short = (id) => (NAME[id] || id).replace(/ \(by hand\)$/, '');

// The ticks of section 5 -> the place ids here.
export function placesFromSources(list) {
  const map = {
    Naukri: 'naukri', Foundit: 'foundit', Shine: 'shine', Indeed: 'indeed', LinkedIn: 'linkedin', 'Google Jobs': 'google', 'TeamLink Job Portal': 'career', 'TeamLink Website': 'career',
  };
  const out = [...new Set((list || []).map((s) => map[s]).filter(Boolean))];
  return out.length ? out : ['naukri', 'indeed', 'shine', 'career'];
}

const CMD = (p) => `npm run portal-session -- ${p}`;

// One site's login box.
function LoginPanel({ portal, info, worker, onConnected, canSwitch, reload, onShown }) {
  const name = short(portal);
  const c = info.credential || {};
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [stage, setStage] = useState(''); // '' | saving | testing | done
  const [result, setResult] = useState(null); // { kind: connected | human | failed | waiting | noworker, text }
  const [err, setErr] = useState('');
  const alive = useRef(true);
  useEffect(() => { onShown(portal); return () => { alive.current = false; }; }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const hasLogin = !!c.hasLogin;

  const poll = useCallback(async (startedWorker) => {
    setStage('testing'); setResult(null);
    for (let i = 0; i < 24 && alive.current; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 2500));
      // eslint-disable-next-line no-await-in-loop
      const s = await jp.get(`/credentials/${portal}/status`).catch(() => null);
      const st = s && s.credential && s.credential.status;
      if (!alive.current) return;
      if (st === 'CONNECTED') { setStage('done'); setResult({ kind: 'connected' }); reload(); onConnected(portal); return; }
      if (st === 'FAILED') { setStage('done'); setResult({ kind: 'failed', text: s.credential.lastError }); reload(); return; }
      if (st === 'NEEDS_HUMAN') { setStage('done'); setResult({ kind: 'human', text: s.credential.lastError }); reload(); return; }
      if (s && s.worker && !s.worker.running && !startedWorker && i >= 2) break;
    }
    if (!alive.current) return;
    setStage('done'); setResult({ kind: 'waiting' });
  }, [portal, onConnected, reload]);

  async function test() {
    setErr(''); setStage('testing'); setResult(null);
    try {
      const out = await jp.post(`/credentials/${portal}/verify`, {});
      if (out.worker && !out.worker.running) { setStage('done'); setResult({ kind: 'noworker' }); return; }
      await poll(true);
    } catch (e) { setStage(''); setErr(jpError(e)); }
  }
  async function saveAndConnect() {
    if (!user.trim() || !pass.trim()) { setErr('Type the username and the password.'); return; }
    setErr(''); setStage('saving');
    try {
      await jp.put(`/credentials/${portal}`, { username: user.trim(), password: pass });
      setPass(''); setUser(''); // the password is never kept on this screen
      reload();
      await test();
    } catch (e) { setStage(''); setErr(jpError(e, 'The login could not be saved.')); }
  }
  const busy = stage === 'saving' || stage === 'testing';

  return (
    <div className="ps-login" role="group" aria-label={`${name} login`}>
      {!hasLogin ? (
        <>
          <b className="ps-login-t">{`${name} login needed`}</b>
          <div className="ps-hint">{`This is the company's ${name} recruiter login. It is saved locked (encrypted) and is never shown again. After it connects, this job posts by itself with the text you just saw.`}</div>
          <div className="ps-login-grid">
            <label className="field"><span>{`${name} username or email`}</span><input autoComplete="off" value={user} onChange={(e) => setUser(e.target.value)} disabled={busy} /></label>
            <label className="field"><span>Password</span><input type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} disabled={busy} /></label>
          </div>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={saveAndConnect}>{stage === 'saving' ? 'Saving…' : stage === 'testing' ? 'Testing…' : 'Save and connect'}</button>
        </>
      ) : (
        <>
          <b className="ps-login-t">{`${name} login is saved`}</b>
          <div className="ps-hint">{c.statusWords ? `Last check: ${c.statusWords}.` : ''}</div>
          {!(stage === 'done' && result && result.kind === 'connected') && c.status !== 'CONNECTED' && (
            <button type="button" className="btn" disabled={busy} onClick={test}>{stage === 'testing' ? 'Testing…' : 'Test connection'}</button>
          )}
          {c.status === 'FAILED' && <div className="ps-bad">{`The last sign-in failed. Only an Admin can change a saved login: ask your Admin (Company Setup, Job portal logins).`}</div>}
        </>
      )}
      {stage === 'testing' && <div className="ps-info" role="status">{`Testing the ${name} login. This can take up to a minute…`}</div>}
      {err && <div className="ps-bad" role="alert">{err}</div>}
      {result && result.kind === 'connected' && <div className="ps-good" role="status">{`Connected. Posting to ${name} now.`}</div>}
      {result && result.kind === 'failed' && <div className="ps-bad" role="alert">{`Failed: the username or password was not accepted by ${name}. ${canSwitch ? 'Open Company Setup, Job portal logins to save the right one.' : 'Ask your Admin to save the right login (Company Setup, Job portal logins). Trying again with a wrong password can lock the account.'}`}</div>}
      {result && result.kind === 'human' && (
        <div className="ps-warn" role="alert">
          <b>{`${name} needs a person to sign in once in the browser (CAPTCHA or code).`}</b>
          <ol>
            <li>On the computer that runs the posting worker, open a terminal in the TeamLink <code>backend</code> folder.</li>
            <li>Run <code>{CMD(portal)}</code></li>
            <li>A browser window opens. Sign in to {name}, solve the CAPTCHA or type the code, then close the window.</li>
            <li>Come back here and press <b>Test connection</b>.</li>
          </ol>
        </div>
      )}
      {result && result.kind === 'noworker' && <div className="ps-warn" role="status">The login is saved, but the posting worker is not running, so it could not be tested yet. Ask the person who looks after TeamLink to start it (<code>npm run posting-worker</code>), then press Test connection.</div>}
      {result && result.kind === 'waiting' && <div className="ps-warn" role="status">{worker && worker.running === false ? 'The posting worker is not running, so the test is waiting. ' : 'The test is still waiting. '}Press Test connection again in a minute.</div>}
    </div>
  );
}

function SwitchPanel({ portal, canSwitch, onSwitched, api = false }) {
  const name = short(portal);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function go() {
    setBusy(true); setErr('');
    try { await jp.post(`/credentials/${portal}/switch`, { enabled: true }); await onSwitched(portal); } catch (e) { setErr(jpError(e)); } finally { setBusy(false); }
  }
  return (
    <div className="ps-login" role="group" aria-label={`${name} posting is switched off`}>
      <b className="ps-login-t">{`${name} posting is switched off`}</b>
      {canSwitch ? (
        <>
          <div className="ps-hint">{api ? `${name} is connected. Posting to it stays off until an Admin switches it on. Nothing is posted until then.` : `The login is saved. Automatic posting to ${name} stays off until an Admin switches it on.`}</div>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={go}>{busy ? 'Switching on…' : `Switch on ${name} posting`}</button>
        </>
      ) : <div className="ps-hint">{api ? `Ask your Admin to switch on ${name} posting. Until then nothing is posted to ${name}.` : `Ask your Admin to switch on ${name} posting. Until then ${name} gets a by-hand task with this text instead.`}</div>}
      {err && <div className="ps-bad" role="alert">{err}</div>}
    </div>
  );
}

// Naukri and Shine are posted BY HAND on the tiles (the Naukri -> Shine workflow). The old automatic worker for them stays reachable in More places.
const MORE = ['foundit', 'google', 'telegram', 'whatsapp']; // "More channels": ticked in the same list, posted by the same button
const MORE_NAME = {};
const SAVED_ONLY = 'Saved. Nothing was posted yet: open the requirement and press Post when you are ready.';

// stay: the caller shows its own "posted" screen (PostStepDialog: "now all the responses will come to ..."), so no page change
export default function PostStep({ job, initial = [], onDone, onBack = null, onAnother = null, startTargets = null, stay = false }) {
  const navigate = useNavigate();
  const [picked, setPicked] = useState(() => initial.filter((x) => MORE.includes(x) && !MANUAL.includes(x))); // the "More places" ticks (never pre-ticks the worker for Naukri / Shine)
  const [portals, setPortals] = useState(null); // answer of /job-publish/portals
  const [off, setOff] = useState('');
  const [lists, setLists] = useState([]);
  const [listId, setListId] = useState('');
  const [dry, setDry] = useState(null); // null = not decided yet (follows "verified")
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [answer, setAnswer] = useState(null);
  const [chips, setChips] = useState([]);
  const [shown, setShown] = useState({}); // a login box that was opened stays until the site is unticked (it holds the test result)
  const polls = useRef(0);
  // the four screens
  const [view, setView] = useState(startTargets && startTargets.length ? 'compose' : 'platforms'); // platforms | compose | preview | flow | done
  const [selected, setSelected] = useState([]); // the tiles with a blue border
  const [targets, setTargets] = useState(startTargets || []); // the places the next Post goes to (startTargets: opened from the job's Postings tab)
  const [text, setText] = useState(() => buildLayout(job));
  const [written, setWritten] = useState(null); // what the template engine wrote for this job (all four texts), null until read
  const [sites, setSites] = useState([]); // GET /requirements/:id/posting-sites (our Job Portal / Website answer for themselves)
  const [loginOpen, setLoginOpen] = useState({});
  const [posting, setPosting] = useState(false);
  const [dryUsed, setDryUsed] = useState(false);
  const [screenErr, setScreenErr] = useState('');
  const sitePolls = useRef(0);
  // the Naukri -> Shine by-hand workflow (state kept on the server: /api/job-flow)
  const [flow, setFlow] = useState(null);
  const [flowMsg, setFlowMsg] = useState('');
  const [flowErr, setFlowErr] = useState('');
  const [flowBusy, setFlowBusy] = useState(false);
  const [copied, setCopied] = useState(null); // did the job text reach the clipboard when Post was pressed? null = not tried yet
  const [thenShine, setThenShine] = useState(true);
  const [tabTick, setTabTick] = useState(0);
  const wins = useRef({ naukri: null, shine: null, prepared: false });
  const resumed = useRef(false);
  const flowErrRef = useRef('');

  const reload = useCallback(() => jp.get('/portals').then((d) => { setPortals(d); setOff(''); return d; }).catch((e) => { setOff(isNotMigrated(e) ? 'off' : jpError(e)); return null; }), []);
  useEffect(() => { reload(); api.get('/job-broadcast/lists').then((r) => setLists(r.data.lists || [])).catch(() => {}); }, [reload]);
  useEffect(() => { api.get(`/job-broadcast/jobs/${job.id}/ready-template`).then((r) => setWritten(r.data.texts || {})).catch(() => setWritten({})); }, [job.id]);

  const infoOf = (k) => (portals && portals.portals.find((p) => p.portal === k)) || null;
  const canSwitch = !!(portals && portals.canAdmin);
  const tickedAuto = picked.filter((k) => AUTO.includes(k));
  const tickedApi = picked.filter((k) => API.includes(k));
  const unverifiedOf = (ids) => ids.filter((k) => AUTO.includes(k)).some((k) => { const i = infoOf(k); return !(i && i.settings && i.settings.verified); });
  const dryOnFor = (ids) => (dry === null ? unverifiedOf(ids) : dry);
  const dryOn = dryOnFor(picked);

  const loadStatus = useCallback(() => api.get(`/job-broadcast/jobs/${job.id}/post-status`).then((r) => setChips(r.data.chips || [])).catch(() => {}), [job.id]);
  useEffect(() => { loadStatus(); }, [loadStatus]);
  useEffect(() => {
    if (!chips.some((c) => ['queued', 'running'].includes(c.state)) || polls.current > 60) return undefined;
    const t = setTimeout(() => { polls.current += 1; loadStatus(); }, 3000);
    return () => clearTimeout(t);
  }, [chips, loadStatus]);

  const loadSites = useCallback(() => api.get(`/requirements/${job.id}/posting-sites`).then((r) => { setSites(r.data.sites || []); return r.data.sites || []; }).catch(() => []), [job.id]);
  useEffect(() => { loadSites(); }, [loadSites]);
  useEffect(() => {
    if (!sites.some((s) => ['jobportal', 'website'].includes(s.id) && ['pending', 'queued', 'posting…', 'retrying…'].includes(String(s.status).toLowerCase())) || sitePolls.current > 20) return undefined;
    const t = setTimeout(() => { sitePolls.current += 1; loadSites(); }, 3000);
    return () => clearTimeout(t);
  }, [sites, loadSites]);

  const toggle = (id) => { setShown((s) => ({ ...s, [id]: false })); setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id])); };

  // post-everywhere for these places; true = the server accepted the call (what it says about each place is in `answer`)
  const run = useCallback(async (places, dryRun) => {
    setBusy(true); setErr('');
    const body = { places, listId: places.includes('whatsapp') ? listId : undefined, dryRun: !!dryRun };
    try {
      let r;
      try { r = await api.post(`/job-broadcast/jobs/${job.id}/post-everywhere`, body); } catch (e) {
        if (e.response?.status === 409 && e.response.data?.code === 'ACT_CONFIRM_SEND' && window.confirm(e.response.data.error)) r = await api.post(`/job-broadcast/jobs/${job.id}/post-everywhere`, body, { headers: { 'X-Act-Confirm': 'send' } });
        else throw e;
      }
      setAnswer((old) => {
        const mine = r.data.results || [];
        const keep = (old || []).filter((x) => !mine.some((m) => m.place === x.place));
        return [...keep, ...mine];
      });
      polls.current = 0; await loadStatus();
      return true;
    } catch (e) { const m = e.response?.data?.error || 'That did not work. Please try again.'; setErr(m); setScreenErr(m); return false; } finally { setBusy(false); }
  }, [job.id, listId, loadStatus]);

  // The login is connected (or the switch is on) -> the post for that site is queued by itself.
  const connected = useCallback(async (portal) => {
    const d = await reload();
    const i = d && d.portals.find((p) => p.portal === portal);
    if (i && i.credential && !i.credential.enabled) return; // the switch panel shows next
    await run([portal], dry === null ? !(i && i.settings && i.settings.verified) : dry);
  }, [reload, run, dry]);

  // one sentence for the notice on the page behind this window
  const finish = () => {
    const list = (chips.length ? chips.map((c) => [c.name, c.state]) : (answer || []).map((x) => [x.name, x.state]));
    const own = sites.filter((s) => ['jobportal', 'website'].includes(s.id) && ['posted', 'failed'].includes(String(s.status).toLowerCase())).map((s) => [s.name, String(s.status).toLowerCase() === 'posted' ? 'posted' : 'failed']);
    const parts = [...list, ...own].filter((x) => x[1] !== 'idle').map(([n, st]) => `${n}: ${(LABEL[st] || st).toLowerCase()}`);
    return { answer, chips, summary: parts.length ? `Saved. ${parts.join(', ')}.` : SAVED_ONLY };
  };
  const retry = async (c) => { try { await api.post(`/job-publish/queue/${c.queueId}/retry`); polls.current = 0; await loadStatus(); } catch (e) { setErr(e.response?.data?.error || 'Could not try again.'); } };

  const needsPanel = (k) => {
    const i = infoOf(k);
    if (!i || !i.credential) return null;
    if (!i.credential.hasLogin) return 'login';
    if (!i.credential.enabled) return 'switch';
    return null;
  };

  // ---- the new flow -----------------------------------------------------------------------------------------------
  const nameOf = (id) => (cardOf(id) || {}).name || NAME[id] || id;
  const stateOf = (id) => cardState(id, { site: sites.find((s) => s.id === id) || null, chip: chips.find((c) => c.place === id) || null, res: (answer || []).find((x) => x.place === id) || null, flow });
  const namesOf = (ids) => ids.map(nameOf).join(', ');

  // Our own Job Portal / Website: tick it, send it, and let the site answer. Posted shows only when the portal / page confirms.
  async function ownPost(id) {
    try {
      const base = `/requirements/${job.id}/posting-sites`;
      const cur = await api.get(base);
      const ticked = (cur.data.sites || []).filter((s) => s.ticked).map((s) => s.id);
      if (!ticked.includes(id)) await api.put(base, { sites: [...ticked, id] });
      const r = await api.post(`${base}/${id}/retry`);
      setSites(r.data.sites || []); sitePolls.current = 0;
      return true;
    } catch (e) { setScreenErr(e.response?.data?.error || `${nameOf(id)} did not take the requirement. Please try again.`); await loadSites(); return false; }
  }
  // Keep the text on screen as the text every board gets: save it as a new version and make it the one in use.
  async function keepText() {
    const filled = fillTemplate(text, job);
    const open = unresolved(filled);
    if (open.length) return `Fill in ${open.map((w) => `{{${w}}}`).join(', ')} or take it out of the text first.`;
    if (!filled.trim()) return 'The text is empty.';
    const same = written && written.jobPost && written.jobPost.replace(/\s+/g, ' ').trim() === filled.replace(/\s+/g, ' ').trim();
    if (same) return '';
    try {
      const s = await api.post(`/job-broadcast/jobs/${job.id}/ready-template`, { texts: { jobPost: filled }, note: 'Edited in the Post step' });
      await api.post(`/job-broadcast/jobs/${job.id}/ready-template/use`, { version: s.data.version });
      setWritten((w) => ({ ...(w || {}), jobPost: filled }));
      if (filled !== text) setText(filled);
      return '';
    } catch (e) { return e.response?.data?.error || 'The text could not be saved, so nothing was posted.'; }
  }
  async function submit(ids) {
    // 1. the tabs are opened FIRST, straight from the person's click (browsers refuse a new tab after anything is awaited)
    const manual = ids.filter((id) => MANUAL.includes(id));
    if (manual.length) copyForSite();
    let nw = null; let sw = null;
    if (manual.length) {
      wins.current = { naukri: null, shine: null, prepared: false };
      if (manual.includes('naukri')) nw = openBlank('tl_naukri', 'Naukri');
      if (manual.includes('shine') || (manual.includes('naukri') && thenShine)) { sw = openBlank('tl_shine', 'Shine'); wins.current.prepared = true; }
      wins.current.naukri = nw; wins.current.shine = sw;
    }
    const closeTabs = () => { try { if (nw) nw.close(); if (sw) sw.close(); } catch { /* ok */ } wins.current = { naukri: null, shine: null, prepared: false }; };
    setPosting(true); setScreenErr(''); setErr(''); setFlowErr(''); setFlowMsg('');
    try {
      const engine = ids.filter((id) => (cardOf(id) || {}).via === 'engine' && !MANUAL.includes(id));
      const own = ids.filter((id) => (cardOf(id) || {}).via === 'own');
      if (engine.length || manual.length) { const e = await keepText(); if (e) { closeTabs(); setScreenErr(e); return false; } }
      setDryUsed(false);
      if (engine.length && !(await run(engine, false))) { closeTabs(); return false; }
      const extra = ids.filter((id) => !cardOf(id));
      if (extra.length) {
        if (extra.includes('whatsapp') && !listId) { closeTabs(); setScreenErr('Pick a contact list for WhatsApp first. Go Back, open More channels and choose one.'); return false; }
        const xDry = extra.some((id) => AUTO.includes(id) || API.includes(id)) && dryOnFor(extra);
        if (xDry) setDryUsed(true);
        if (!(await run(extra, xDry))) { closeTabs(); return false; }
      }
      for (let i = 0; i < own.length; i += 1) { if (!(await ownPost(own[i]))) { closeTabs(); return false; } } // eslint-disable-line no-await-in-loop
      if (manual.includes('naukri')) {
        if (manual.includes('shine')) setThenShine(true);
        if (!(await startNaukri(nw, sw))) { setScreenErr(flowErrRef.current || 'Naukri could not be started.'); return false; }
      } else if (manual.includes('shine')) {
        await openShine(false, true);
      }
      await Promise.all([loadSites(), loadStatus(), loadFlow()]);
      setView(manual.length ? 'flow' : 'done');
      return true;
    } finally { setPosting(false); }
  }
  // OPEN + COPY: the job text goes to the clipboard by itself on the press, so it is ready to paste on the site. Posted is still only what the person confirms.
  function copyForSite() { copyText(fillTemplate(text, job)).then(setCopied); }
  // ---- the Naukri -> Shine by-hand workflow --------------------------------------------------------------------------
  // Browsers only allow a new tab straight after the person's own click. So the click opens the tabs (Naukri, and a named blank
  // tab that Shine is sent to later) BEFORE anything is awaited. Nothing is hidden, nothing is typed into the sites.
  const loadFlow = useCallback(() => api.get(`/job-flow/jobs/${job.id}`).then((r) => { setFlow(r.data); return r.data; }).catch(() => null), [job.id]);
  useEffect(() => {
    loadFlow().then((f) => {
      // refreshed or came back later: go on from where the server says we were (no second job, no second start)
      if (f && !resumed.current && f.resume && ['naukri', 'shine'].includes(f.resume.step)) { resumed.current = true; setView('flow'); }
    });
  }, [loadFlow]);
  async function flowCall(platform, event, body) {
    try {
      const r = await api.post(`/job-flow/jobs/${job.id}/${platform}/${event}`, body || {});
      setFlow(r.data);
      return r.data;
    } catch (e) {
      const d = e.response?.data || {};
      if (d.rows) setFlow(d);
      const m = d.missing && d.missing.length ? `Fill these first, then post: ${d.missing.join(', ')}.` : (d.error || 'That did not work. Please try again.');
      flowErrRef.current = m; setFlowErr(m);
      return null;
    }
  }
  const rowOf = (p) => (flow && flow.rows.find((r) => r.platform === p)) || null;
  const siteUrl = (p) => (flow && flow.urls && flow.urls[p]) || null;
  const openBlank = (name, label) => {
    let w = null;
    try { w = window.open('about:blank', name); } catch { w = null; }
    if (w) { try { w.document.title = label; w.document.body.innerHTML = `<p style="font-family:sans-serif;padding:24px">${label}: TeamLink opens it here when it is time. Go back to the TeamLink tab.</p>`; } catch { /* a blank tab we can not write to: harmless */ } }
    return w;
  };
  const goTo = (w, url) => { try { if (w && !w.closed && url) { w.location.href = url; return true; } } catch { /* the tab went away */ } return false; };
  const alive = (w) => { try { return !!w && !w.closed; } catch { return false; } };

  // watch the Naukri tab: when it closes, ask the person whether the posting was finished (it is only a hint, nothing moves)
  useEffect(() => {
    const st = (rowOf('naukri') || {}).status;
    if (!['Naukri Portal Opened', 'Awaiting Naukri Completion'].includes(st) || !wins.current.naukri) return undefined;
    const t = setInterval(() => {
      if (!alive(wins.current.naukri)) { wins.current.naukri = null; setTabTick((n) => n + 1); setFlowMsg('The Naukri tab was closed. If you finished posting, press I posted it on Naukri. If not, press Open Naukri again.'); }
    }, 1500);
    return () => clearInterval(t);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  // Naukri: validate the saved job, remember the start, point the already-opened tab at Naukri's recruiter login
  async function startNaukri(nw, sw) {
    setFlowErr(''); setFlowMsg('');
    const s = await flowCall('naukri', 'start');
    if (!s) { try { if (nw) nw.close(); if (sw) sw.close(); } catch { /* ok */ } wins.current = { naukri: null, shine: null, prepared: false }; return false; }
    if ((s.rows.find((r) => r.platform === 'naukri') || {}).status === 'Naukri Completion Confirmed') return true; // already done: resume, do not start again
    if (!goTo(nw, s.urls.naukri)) { await flowCall('naukri', 'action', { code: 'popup_blocked' }); setFlowMsg('Your browser blocked the new tab. Press Open Naukri to open it.'); return true; }
    await flowCall('naukri', 'opened'); await flowCall('naukri', 'await');
    return true;
  }
  // "Open Naukri again" / "Open Naukri": a fresh click opens a fresh tab
  async function openNaukri() {
    copyForSite();
    const nw = openBlank('tl_naukri', 'Naukri'); wins.current.naukri = nw; setFlowErr(''); setFlowMsg(''); setFlowBusy(true);
    try {
      const st = (rowOf('naukri') || {}).status;
      if (['Failed', 'Action Required'].includes(st)) await flowCall('naukri', 'retry');
      if (!nw) { await flowCall('naukri', 'action', { code: 'popup_blocked' }); setFlowMsg('Your browser blocked the new tab. Allow pop-ups for TeamLink, then press Open Naukri again.'); return; }
      if (!goTo(nw, siteUrl('naukri'))) { await flowCall('naukri', 'action', { code: 'open_failed' }); return; }
      await flowCall('naukri', 'opened'); await flowCall('naukri', 'await');
    } finally { setFlowBusy(false); }
  }
  // Shine: only after Naukri is confirmed (or when Shine is the only place picked). Never submits anything.
  async function openShine(fresh, standalone) {
    let sw = wins.current.shine;
    if (fresh) copyForSite();
    if (fresh) { sw = openBlank('tl_shine', 'Shine'); wins.current.shine = sw; wins.current.prepared = true; }
    setFlowErr(''); setFlowMsg(''); setFlowBusy(true);
    try {
      const st = (rowOf('shine') || {}).status;
      if (['Failed', 'Action Required'].includes(st)) await flowCall('shine', 'retry');
      const r = await flowCall('shine', 'opening', standalone ? { standalone: true } : {});
      if (!r) return;
      if (!fresh && !alive(sw)) {
        // no prepared tab (page was reloaded, or the tab was closed): say so, the person presses Open Shine
        if (wins.current.prepared) { await flowCall('shine', 'action', { code: 'shine_tab_missing' }); setFlowMsg('The Shine tab was closed or blocked, so Shine did not open by itself. Press Open Shine to open it now.'); } else setFlowMsg('Naukri is done. Press Open Shine to open Shine.');
        return;
      }
      if (!goTo(sw, siteUrl('shine'))) { await flowCall('shine', 'action', { code: fresh ? 'popup_blocked' : 'open_failed' }); setFlowMsg('Shine did not open. Allow pop-ups for TeamLink, then press Open Shine.'); return; }
      await flowCall('shine', 'opened'); await flowCall('shine', 'await');
    } finally { setFlowBusy(false); }
  }
  // the recruiter's own words: "Naukri Posting Completed" -> Shine opens by itself in the prepared tab
  async function confirmNaukri(url) {
    setFlowBusy(true); setFlowErr(''); setFlowMsg('');
    try {
      const r = await flowCall('naukri', 'confirm', url ? { url } : {});
      if (!r) return;
      await loadSites();
      if (thenShine) { setFlowBusy(false); await openShine(false, false); }
    } finally { setFlowBusy(false); }
  }
  // "Not posted after all": the server removes the by-hand record, so no board is called Posted that was not
  async function undoPosted(platform) {
    setFlowBusy(true); setFlowErr(''); setFlowMsg('');
    try {
      const r = await flowCall(platform, 'unconfirm');
      if (!r) return;
      setFlowMsg(platform === 'naukri' ? 'Undone: Naukri is not marked as posted any more. Post it there, then press I posted it on Naukri.' : 'Undone: Shine is not marked as posted any more.');
      await loadSites();
    } finally { setFlowBusy(false); }
  }
  async function notFinished() { await flowCall('naukri', 'await'); setFlowMsg('Nothing was posted. Finish posting on Naukri, then press I posted it on Naukri.'); }
  async function shineDone(url) {
    setFlowBusy(true);
    try { const r = await flowCall('shine', 'complete', url ? { url } : {}); if (r) await loadSites(); } finally { setFlowBusy(false); }
  }

  const goCompose = (ids) => { setTargets(ids); setScreenErr(''); setView('compose'); };
  const retryCard = async (id) => {
    const st = stateOf(id);
    if (st.queueId) { await retry({ queueId: st.queueId }); return; }
    if ((cardOf(id) || {}).via === 'own') { setPosting(true); await ownPost(id); await loadSites(); setPosting(false); return; }
    goCompose([id]);
  };
  const useTemplate = () => { setText(buildLayout(job)); setScreenErr(''); };
  const useWritten = written && written.jobPost ? () => { setText(fillTemplate(written.jobPost, job)); setScreenErr(''); } : null;
  const goPosted = () => { onDone(finish()); if (!stay) navigate('/requirements?tab=posting'); };

  const waitingFor = tickedAuto.filter((k) => needsPanel(k));
  const where = namesOf(targets);
  const autoTargets = targets.filter((id) => AUTO.includes(id) && !MANUAL.includes(id)); // Naukri / Shine are by hand now: no dry run for them
  const ownOnly = targets.length > 0 && targets.every((id) => (cardOf(id) || {}).via === 'own');
  const socialOnly = targets.length > 0 && targets.every((id) => API.includes(id));
  const panelFor = (id) => {
    const i = infoOf(id);
    if (!i || !i.credential) return <div className="ps-hint">{off === 'off' ? 'Job publishing is not switched on yet.' : 'The login box is not available right now.'}</div>;
    return (
      <>
        <LoginPanel portal={id} info={i} worker={portals && portals.worker} onConnected={connected} canSwitch={canSwitch} reload={reload} onShown={() => {}} />
        {i.credential.hasLogin && !i.credential.enabled && <SwitchPanel portal={id} canSwitch={canSwitch} onSwitched={connected} />}
      </>
    );
  };

  // one tick row of "More channels"
  const placeRow = ([id, name, hint]) => {
    const on = AUTO.includes(id) && picked.includes(id);
    const i = infoOf(id);
    const c = (i && i.credential) || null;
    const showLogin = on && c && (!c.hasLogin || c.status !== 'CONNECTED' || shown[id]);
    const showSwitch = on && c && c.hasLogin && !c.enabled;
    const ch = chips.find((x) => x.place === id && x.state !== 'idle');
    return (
      <div key={id} className="ps-site">
        <label className={`bc-place${picked.includes(id) ? ' on' : ''}`}>
          <input type="checkbox" checked={picked.includes(id)} onChange={() => toggle(id)} />
          <span>{name}<small>{hint}</small></span>
          {ch && <StatusChip tone={TONE[ch.state] || 'grey'}>{LABEL[ch.state] || ch.state}</StatusChip>}
          {!ch && API.includes(id) && c && (
            <StatusChip tone={!c.hasLogin ? 'grey' : !c.enabled ? 'grey' : c.status === 'FAILED' ? 'red' : 'green'}>
              {!c.hasLogin ? 'Not set up' : !c.enabled ? 'Switched off' : c.status === 'FAILED' ? 'Token failed' : 'Ready'}
            </StatusChip>
          )}
          {!ch && AUTO.includes(id) && c && (
            <StatusChip tone={!c.hasLogin ? 'grey' : c.status === 'CONNECTED' ? 'green' : c.status === 'FAILED' ? 'red' : 'yellow'}>
              {!c.hasLogin ? 'No login yet' : !c.enabled ? 'Switched off' : c.status === 'CONNECTED' ? 'Connected' : c.status === 'FAILED' ? 'Login failed' : 'Not checked yet'}
            </StatusChip>
          )}
        </label>
        {showLogin && <LoginPanel portal={id} info={i} worker={portals && portals.worker} onConnected={connected} canSwitch={canSwitch} reload={reload} onShown={(p) => setShown((s2) => (s2[p] ? s2 : { ...s2, [p]: true }))} />}
        {showSwitch && <SwitchPanel portal={id} canSwitch={canSwitch} onSwitched={connected} />}
      </div>
    );
  };

  // ---- the social media tiles of screen 1 (Facebook, Instagram, LinkedIn, Threads) --------------------------------------
  // the little word on a tile: is the account connected and is posting switched on
  const socialSetup = (id) => {
    const c = (infoOf(id) || {}).credential;
    if (!c) return null;
    if (!c.hasLogin) return { label: 'Not connected', tone: 'grey' };
    if (c.status === 'FAILED') return { label: 'Connection refused', tone: 'red' };
    if (!c.enabled) return { label: 'Switched off', tone: 'grey' };
    return { label: 'Ready', tone: 'green' };
  };
  // what a ticked social tile still needs, said under the tiles (never a silent failure)
  const socialPanel = (id) => {
    const c = (infoOf(id) || {}).credential;
    const name = NAME[id];
    if (!c) return off && off !== 'off' ? <div className="ps-bad" role="alert">{off}</div> : <div className="ps-hint">{`${name} is not available right now. An Admin connects it in Administration, Integrations, Social Media.`}</div>;
    if (!c.hasLogin) return <div className="ps-login"><b className="ps-login-t">{`${name} is not connected yet`}</b><div className="ps-hint">{canSwitch ? <>Connect it once in <Link to={`/admin/integrations?tab=facebook&sub=${SOCIAL_TAB[id]}`}>Administration, Integrations, Social Media</Link>. Nothing is posted to {name} until then.</> : `Ask your Admin to connect ${name} (Administration, Integrations, Social Media). Nothing is posted there until then.`}</div></div>;
    if (c.status === 'FAILED') return <div className="ps-bad" role="alert">{`The saved ${name} connection was refused${c.lastError ? ` (${c.lastError})` : ''}. ${canSwitch ? 'Connect it again in Administration, Integrations, Social Media.' : 'Ask your Admin to connect it again.'}`}</div>;
    if (!c.enabled) return <SwitchPanel portal={id} canSwitch={canSwitch} onSwitched={() => reload()} api />;
    return null;
  };

  const stripe = (
    <>
      {portals && portals.killAll && <div className="ps-bad">Posting is stopped for now. Ask an Admin.</div>}
      {portals && portals.paused && <div className="ps-warn">Posting is paused. Requirements wait in the queue.</div>}
      {flow && flow.resume && ['naukri', 'shine'].includes(flow.resume.step) && (
        <div className="pw-notice" role="status"><span>You were in the middle of posting this requirement on Naukri / Shine.</span><button type="button" className="btn btn-sm btn-primary" onClick={() => setView('flow')}>Continue</button></div>
      )}
    </>
  );

  return (
    <div className="ps pw">
      <Stepper step={{ platforms: 1, compose: 2, preview: 3, flow: 4, done: 4 }[view]} />
      {view === 'platforms' && (
        <PlatformScreen
          job={job}
          tiles={[
            ...CARDS.map((c) => ({ id: c.id, name: c.name, hint: c.hint, mode: c.mode, state: stateOf(c.id), loginBtn: false })),
            ...SOCIAL.map((id) => ({ id, name: NAME[id], hint: (PLACES.find((p) => p[0] === id) || [])[2], mode: 'auto', state: stateOf(id), group: 'social', setup: socialSetup(id), loginBtn: false })),
          ]}
          selectedCount={selected.length + picked.length}
          groupTitles={{ social: ['Social media', 'TeamLink posts the job on your own pages too. An Admin connects each one once.'] }}
          selected={selected}
          onToggle={(id) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))}
          onRetry={retryCard}
          onSaveOnly={() => onDone({ ...finish(), summary: SAVED_ONLY })}
          onNext={() => goCompose([...selected, ...picked])}
          onBack={onBack || (() => onDone({ ...finish(), summary: SAVED_ONLY }))}
          busy={busy || posting}
          loginPanels={Object.fromEntries([
            ...Object.keys(loginOpen).filter((k) => loginOpen[k]).map((k) => [k, panelFor(k)]),
            ...SOCIAL.filter((id) => selected.includes(id)).map((id) => [id, socialPanel(id)]).filter((x) => x[1]),
          ])}
          onLogin={(id) => setLoginOpen((o) => ({ ...o, [id]: !o[id] }))}
          notice={stripe}
        >
          {err && <div className="bc-err" role="alert">{err}</div>}

          <details className="pw-more" open={picked.length > 0}>
            <summary>More channels <small>(Foundit, Google Jobs, Telegram, WhatsApp)</small></summary>
            <div className="bc-places">
              {PLACES.filter(([id]) => MORE.includes(id)).map(placeRow)}
            </div>
            {picked.includes('whatsapp') && (
              <div className="bc-row">
                <span style={{ fontWeight: 600, fontSize: 13 }}>Send to list</span>
                {lists.length === 0 && <span className="bc-note">No contact list yet. Add one in Candidates, Contact lists.</span>}
                {lists.map((l) => <button type="button" key={l.id} className={`bc-tab${listId === l.id ? ' on' : ''}`} onClick={() => setListId(l.id)}>{l.name}</button>)}
              </div>
            )}
          </details>
          {err && <div className="bc-err" role="alert">{err}</div>}
          <JobHelp jobId={job.id} onChanged={loadStatus} />
        </PlatformScreen>
      )}

      {view === 'compose' && (
        <ComposeScreen
          names={where}
          text={text}
          onText={setText}
          onUseTemplate={useTemplate}
          onUseWritten={useWritten}
          tools={(
            <>
              <EditTemplateButton requirementId={job.id} label="Edit template" />
              <details className="rsp-lib pw-lib">
                <summary>My job templates</summary>
                <TemplateLibrary
                  texts={{ whatsapp: '', sms: '', emailSubject: '', emailBody: '', ...(written || {}), jobPost: text }}
                  jobTitle={job.title || ''}
                  onUse={(t) => { const jp2 = t && t.texts && t.texts.jobPost; if (jp2) setText(fillTemplate(jp2, job)); }}
                />
              </details>
            </>
          )}
          dryShown={autoTargets.length > 0}
          dry={dryOnFor(targets)}
          onDry={setDry}
          dryNote={unverifiedOf(targets) ? 'On for now because a site here is not marked verified yet. An Admin marks a site verified after a real test post.' : 'Untick to post for real.'}
          manual={targets.some((id) => MANUAL.includes(id)) ? { askShine: targets.includes('naukri') && !targets.includes('shine'), thenShine, onThenShine: setThenShine } : null}
          ownOnly={ownOnly || socialOnly}
          ownNote={socialOnly ? "TeamLink writes the post for each social page from the requirement (a short text with the apply link; Instagram also gets a picture of the job). The text above is for the job sites. To change a social post, edit its text on the Distribute list, or press Check only first to read it." : "Our Job Portal and Website show the requirement details saved on the requirement. To change those, edit the requirement."}
          err={screenErr}
          busy={posting}
          posting={posting}
          onBack={() => setView('platforms')}
          onPreview={() => { setScreenErr(''); setView('preview'); }}
          onPost={() => submit(targets)}
        />
      )}

      {view === 'preview' && (
        <PreviewScreen
          where={where}
          text={fillTemplate(text, job)}
          job={job}
          busy={posting}
          posting={posting}
          err={screenErr}
          dryNote={autoTargets.length > 0 && dryOnFor(targets) ? 'Dry run is on: pressing Post only checks the sign-in and the form. Nothing is posted.' : ''}
          onBack={() => setView('compose')}
          onPost={() => submit(targets)}
        />
      )}

      {view === 'flow' && (
        <FlowScreen
          job={job}
          flow={flow}
          msg={flowMsg}
          err={flowErr}
          busy={flowBusy || posting}
          copied={copied}
          shineTabOpen={alive(wins.current.shine) && tabTick >= 0}
          onUndo={undoPosted}
          naukriTabOpen={alive(wins.current.naukri) && tabTick >= 0}
          otherRows={targets.filter((id) => !MANUAL.includes(id)).map((id) => ({ id, name: nameOf(id), state: stateOf(id) }))}
          onOpenNaukri={openNaukri}
          onConfirmNaukri={confirmNaukri}
          onNotFinished={notFinished}
          onOpenShine={() => openShine(true, !rowOf('naukri'))}
          onShineDone={shineDone}
          onBack={() => { setSelected([]); setView('platforms'); }}
          onViewPosted={goPosted}
          onAnother={onAnother ? () => onAnother(finish()) : null}
          onDone={() => onDone(finish())}
        />
      )}

      {view === 'done' && (() => {
        const rows = targets.map((id) => {
          const state = stateOf(id);
          const dryRow = dryUsed && AUTO.includes(id);
          const handNeeded = ['needs_help', 'failed', 'not_connected', 'not_available', 'idle'].includes(state.key) || (state.key === 'queued' && portals && portals.worker && portals.worker.running === false && AUTO.includes(id));
          return {
            id,
            name: nameOf(id),
            state: dryRow && state.key === 'queued' ? { ...state, key: 'idle', note: 'Check only: nothing was posted.' } : state,
            hand: handNeeded || dryRow ? <HandHelp jobId={job.id} id={id} name={nameOf(id)} fallbackText={fillTemplate(text, job)} onChanged={loadSites} /> : null,
          };
        });
        const allGood = rows.every((r) => ['posted', 'hand'].includes(r.state.key));
        return (
          <DoneScreen
            rows={rows}
            allGood={allGood}
            dry={dryUsed}
            busy={posting || busy}
            onRetry={retryCard}
            onViewPosted={goPosted}
            onAnother={onAnother ? () => onAnother(finish()) : null}
            onMore={() => { setSelected([]); setView('platforms'); }}
            onDone={() => onDone(finish())}
          />
        );
      })()}
    </div>
  );
}
