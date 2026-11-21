import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import '../interviews/interviewTools.css';

// ---------------------------------------------------------------------------
// ADMINISTRATION pieces of the market wave (2026-11-21; server routes/mktComms.js)
//   AddonSwitches     Step timing and alerts page: every add-on that messages people or runs by itself, all OFF until turned on,
//                     plus the company's Google / Microsoft calendar app keys (founder credentials)
//   CareersSiteAdmin  Integrations > Job portals > Careers site: the agency's site (hero, about, jobs, alerts, contact) + job-alert list
//   BoardSyncAdmin    Integrations > Job portals > Board applications: Naukri / Shine / foundit / LinkedIn applications in
// ---------------------------------------------------------------------------
const errOf = (e) => (e && e.response && e.response.data && e.response.data.error) || 'That did not work. Please try again.';

export function AddonSwitches() {
  const [d, setD] = useState(null); const [keys, setKeys] = useState({ google: {}, microsoft: {} }); const [err, setErr] = useState(''); const [msg, setMsg] = useState('');
  const load = useCallback(() => api.get('/ats/mkt/switches').then((r) => setD(r.data)).catch((e) => setErr(errOf(e))), []);
  useEffect(() => { load(); }, [load]);
  if (!d) return err ? <div className="error-text">{err}</div> : null;
  const flip = async (k, v) => { setErr(''); setMsg(''); try { const r = await api.put('/ats/mkt/switches', { [k]: v }); setD({ ...d, switches: r.data.switches }); setMsg(`${d.labels[k]}: ${v ? 'ON' : 'OFF'}.`); } catch (e) { setErr(errOf(e)); } };
  const saveKeys = async (p) => { setErr(''); setMsg(''); try { await api.put(`/ats/mkt/calendar-app/${p}`, keys[p]); setKeys({ ...keys, [p]: {} }); setMsg('Calendar app keys saved (the secret is kept encrypted).'); load(); } catch (e) { setErr(errOf(e)); } };
  return (
    <div className="card section" data-testid="addon-switches">
      <h3 style={{ fontSize: 14, margin: '0 0 4px' }}>Add-on switches</h3>
      <div className="small-muted" style={{ marginBottom: 8 }}>Each of these sends messages to candidates or runs by itself, so each starts OFF. {d.canEdit ? '' : 'Only an Admin changes them.'}</div>
      {Object.entries(d.labels).map(([k, label]) => (
        <label key={k} className="mkt-switch">
          <input type="checkbox" checked={!!d.switches[k]} disabled={!d.canEdit} onChange={(e) => flip(k, e.target.checked)} />
          <span><b>{label}</b>{k === 'emailTracking' && <><br /><span className="small-muted">Privacy: the candidate's email carries a 1-pixel image and links that pass through TeamLink; the last line of the email says so ("{d.trackingPrivacy}"). Nothing else about the reader is kept.</span></>}</span>
        </label>
      ))}
      <h3 style={{ fontSize: 14, margin: '12px 0 4px' }}>Calendar apps (Google / Microsoft)</h3>
      <div className="small-muted">So each person can connect their own calendar: create an OAuth app in Google Cloud / Microsoft Entra and paste its Client ID and secret here. Redirect address to register: Google {d.redirect.google} · Microsoft {d.redirect.microsoft}</div>
      {Object.entries(d.calendarApp).map(([p, c]) => (
        <div key={p} className="ivt-row" style={{ marginTop: 6 }}>
          <b style={{ minWidth: 150 }}>{c.label}</b>
          <span className="small-muted">{c.saved ? `saved (Client ID ${c.clientId})` : 'not set up'}</span>
          {d.canEdit && <>
            <input type="text" placeholder="Client ID" value={keys[p].clientId || ''} onChange={(e) => setKeys({ ...keys, [p]: { ...keys[p], clientId: e.target.value } })} />
            <input type="password" autoComplete="new-password" placeholder="Client secret" value={keys[p].secret || ''} onChange={(e) => setKeys({ ...keys, [p]: { ...keys[p], secret: e.target.value } })} />
            {p === 'microsoft' && <input type="text" placeholder="Tenant (or common)" value={keys[p].tenant || ''} onChange={(e) => setKeys({ ...keys, [p]: { ...keys[p], tenant: e.target.value } })} />}
            <button type="button" className="btn btn-sm" disabled={!keys[p].clientId || !keys[p].secret} onClick={() => saveKeys(p)}>Save</button>
          </>}
        </div>
      ))}
      {msg && <div className="notice">{msg}</div>}{err && <div className="error-text">{err}</div>}
    </div>
  );
}

const SECTION_NAMES = { hero: 'Top banner', about: 'About us', jobs: 'Open jobs', alerts: 'Job alerts sign-up', contact: 'Contact' };
export function CareersSiteAdmin() {
  const [d, setD] = useState(null); const [s, setS] = useState(null); const [alerts, setAlerts] = useState(null); const [err, setErr] = useState(''); const [msg, setMsg] = useState('');
  const load = useCallback(() => {
    api.get('/ats/mkt/site').then((r) => { setD(r.data); setS(r.data.site); }).catch((e) => setErr(errOf(e)));
    api.get('/ats/mkt/alerts').then((r) => setAlerts(r.data)).catch(() => null);
  }, []);
  useEffect(() => { load(); }, [load]);
  if (!d || !s) return err ? <div className="error-text">{err}</div> : <div className="small-muted">Loading…</div>;
  const set = (part, patch) => setS({ ...s, [part]: { ...(s[part] || {}), ...patch } });
  const move = (k, dir) => { const l = [...s.sections]; const i = l.indexOf(k); const j = i + dir; if (j < 0 || j >= l.length) return; [l[i], l[j]] = [l[j], l[i]]; setS({ ...s, sections: l }); };
  const toggle = (k) => setS({ ...s, sections: s.sections.includes(k) ? s.sections.filter((x) => x !== k) : [...s.sections, k] });
  const save = async (patch = {}) => { setErr(''); setMsg(''); try { const r = await api.put('/ats/mkt/site', { ...s, ...patch }); setS(r.data.site); setMsg(r.data.site.published ? 'Saved and live.' : 'Saved as a draft (not public).'); } catch (e) { setErr(errOf(e)); } };
  const inp = (part, key, label, props = {}) => <label className="field">{label}<input type="text" value={(s[part] && s[part][key]) || ''} disabled={!d.canEdit} onChange={(e) => set(part, { [key]: e.target.value })} {...props} /></label>;
  return (
    <div className="ivt-body" data-testid="careers-site-admin">
      <div className="small-muted">The agency's own careers site at <a href={d.url} target="_blank" rel="noreferrer">{d.url}</a> - works on phones, in English / Telugu / Hindi, and every job has its own page for Google. {s.published ? <b>Live.</b> : <b>Draft (not public).</b>}</div>
      <div className="mkt-grid">
        {inp('brand', 'name', 'Agency name')}
        <label className="field">Colour<input type="color" value={(s.brand && s.brand.color) || '#1f6feb'} disabled={!d.canEdit} onChange={(e) => set('brand', { color: e.target.value })} /></label>
        {inp('brand', 'logoUrl', 'Logo link (https://...)')}
      </div>
      <div className="mkt-grid">
        {inp('hero', 'title', 'Banner title')}
        {inp('hero', 'subtitle', 'Banner line')}
        {inp('hero', 'button', 'Banner button')}
      </div>
      <label className="field">About us<textarea rows="3" value={(s.about && s.about.text) || ''} disabled={!d.canEdit} onChange={(e) => set('about', { text: e.target.value })} /></label>
      <div className="mkt-grid">
        {inp('jobs', 'title', 'Jobs heading')}
        {inp('contact', 'email', 'Contact email')}
        {inp('contact', 'phone', 'Contact phone')}
        {inp('contact', 'address', 'Address')}
      </div>
      <div className="mkt-sec"><h3>Sections, in order</h3>
        {['hero', 'about', 'jobs', 'alerts', 'contact'].map((k) => (
          <div key={k} className="ivt-row">
            <label><input type="checkbox" checked={s.sections.includes(k)} disabled={!d.canEdit} onChange={() => toggle(k)} /> {SECTION_NAMES[k]}</label>
            {s.sections.includes(k) && d.canEdit && <><button type="button" className="btn btn-sm btn-ghost" aria-label="Move up" onClick={() => move(k, -1)}>↑</button><button type="button" className="btn btn-sm btn-ghost" aria-label="Move down" onClick={() => move(k, 1)}>↓</button></>}
          </div>
        ))}
      </div>
      {d.canEdit && (
        <div className="ivt-row">
          <button type="button" className="btn btn-sm" onClick={() => save({ published: false })}>Save draft</button>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => save({ published: true })}>{s.published ? 'Save (live)' : 'Publish'}</button>
          {s.published && <button type="button" className="btn btn-sm btn-ghost" onClick={() => save({ published: false })}>Take it offline</button>}
          <a className="btn btn-sm btn-ghost" href="/site?preview=1" target="_blank" rel="noreferrer">Open the site</a>
        </div>
      )}
      <div className="small-muted">{d.preview && d.preview.jobs ? `${d.preview.jobs.length} open job(s) show on the site (the jobs published on the Job Portal).` : ''}</div>
      {alerts && (
        <div className="mkt-sec"><h3>Job alerts</h3>
          <div className="small-muted">{alerts.switchOn ? 'On: people sign up on the site, confirm by email, and get new matching jobs (at most once every 6 hours).' : 'Switched off (Step timing and alerts > Add-on switches).'} {alerts.active} active · {alerts.pending} waiting to confirm · {alerts.stopped} stopped.</div>
          {alerts.switchOn && <button type="button" className="btn btn-sm" onClick={async () => { try { const r = await api.post('/ats/mkt/alerts/run', {}); setMsg(r.data.message); } catch (e) { setErr(errOf(e)); } }}>Send alerts now</button>}
          {alerts.recent.slice(0, 10).map((r, i) => <div key={i} className="kv"><span className="k">{r.email}</span><span className="small-muted">{r.status} · {r.keywords || 'any job'}{r.location ? ` · ${r.location}` : ''}</span></div>)}
        </div>
      )}
      {msg && <div className="notice">{msg}</div>}{err && <div className="error-text">{err}</div>}
    </div>
  );
}

export function BoardSyncAdmin() {
  const [d, setD] = useState(null); const [f, setF] = useState({}); const [err, setErr] = useState(''); const [msg, setMsg] = useState('');
  const load = useCallback(() => api.get('/ats/mkt/boards').then((r) => setD(r.data)).catch((e) => setErr(errOf(e))), []);
  useEffect(() => { load(); }, [load]);
  if (!d) return err ? <div className="error-text">{err}</div> : <div className="small-muted">Loading…</div>;
  const run = async (fn) => { setErr(''); setMsg(''); try { await fn(); } catch (e) { setErr(errOf(e)); } };
  const val = (id, k) => (f[id] && f[id][k]) || '';
  const put = (id, k, v) => setF({ ...f, [id]: { ...(f[id] || {}), [k]: v } });
  return (
    <div className="ivt-body" data-testid="board-sync-admin">
      <div className="small-muted">Applications made ON the job boards come straight into the right requirement (no mailbox needed). Each board gives this only with a partner / API account - ask your Naukri (Amplify / RMS), Shine, foundit or LinkedIn (Apply Connect) account manager, then paste what they give here. Posting jobs out stays on each requirement's Postings tab.</div>
      {d.rows.map((b) => (
        <div key={b.id} className="mkt-q">
          <div className="ivt-row"><b>{b.label}</b><span className={`status ${b.ready ? 'active' : 'pending'}`}>{b.ready ? 'set up' : 'needs the board\'s partner details'}</span>{b.lastResult && <span className="small-muted">last pull {new Date(b.lastResult.at).toLocaleString('en-IN')}: {b.lastResult.error || `${b.lastResult.added} added, ${b.lastResult.duplicates} already in`}</span>}</div>
          <div className="small-muted">Give the board this address for new applications (it signs each one with the shared secret, header X-Signature: sha256=…): <code className="ivt-code">{b.webhookUrl}</code></div>
          <div className="ivt-row">
            <input type="password" autoComplete="new-password" placeholder={b.saved.webhookSecret ? 'shared secret saved - type to replace' : 'Shared secret'} value={val(b.id, 'webhookSecret')} onChange={(e) => put(b.id, 'webhookSecret', e.target.value)} />
            <input type="url" placeholder="or the board's applications URL (to pull)" value={val(b.id, 'pullUrl') || b.pullUrl || ''} onChange={(e) => put(b.id, 'pullUrl', e.target.value)} />
            <input type="password" autoComplete="new-password" placeholder={b.saved.apiKey ? 'API key saved' : 'API key'} value={val(b.id, 'apiKey')} onChange={(e) => put(b.id, 'apiKey', e.target.value)} />
            <button type="button" className="btn btn-sm" onClick={() => run(async () => { await api.put(`/ats/mkt/boards/${b.id}`, f[b.id] || {}); setF({ ...f, [b.id]: {} }); setMsg(`${b.label} saved.`); load(); })}>Save</button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => run(async () => { const r = await api.post(`/ats/mkt/boards/${b.id}/pull`, {}); setMsg(`${b.label}: ${r.data.added} added, ${r.data.duplicates} already in${r.data.errors.length ? `, ${r.data.errors.length} not matched` : ''}.`); load(); })}>Pull now</button>
          </div>
        </div>
      ))}
      <div className="small-muted">LinkedIn job wrapping: give LinkedIn this feed address (needs the company page to be approved for it): <code className="ivt-code">{d.linkedinFeed}</code></div>
      {msg && <div className="notice">{msg}</div>}{err && <div className="error-text">{err}</div>}
    </div>
  );
}
