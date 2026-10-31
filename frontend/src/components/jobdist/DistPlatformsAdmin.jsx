import { useCallback, useEffect, useState } from 'react';
import {
  dx, dxError, isNotMigrated, NOT_ON_WORDS, KIND_WORDS, MEDIUM_WORDS,
} from './distKit.js';
import './jobdist.css';
import '../jobpublish/jobpublish.css';
import Combo from '../Combo.jsx';

// ---------------------------------------------------------------------------
// ADMINISTRATION > INTEGRATIONS > Job portals > "Where jobs are posted" (Super Admin and Admin only).
//   * the list of places a job can be posted: name, how (automatic / copy and post / by hand), the link to open, text limits,
//     whether the salary is shown, days until the post expires, and a hint. Seeded with the defaults; Reset puts one back.
//   * reminder days before a post expires
//   * the optional Google Indexing API (OFF; needs the company's own Google service account)
// ---------------------------------------------------------------------------
function PlaceRow({ p, reload, flash }) {
  const [v, setV] = useState({});
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const val = (k) => (v[k] !== undefined ? v[k] : (p[k] == null ? '' : p[k]));
  const dirty = Object.keys(v).length > 0;
  const set = (k, x) => setV({ ...v, [k]: x });
  const locked = ['career', 'google', 'feed', 'telegram', 'facebook', 'instagram', 'threads', 'linkedinpost'].includes(p.key);
  async function run(key, fn, ok) {
    setBusy(key); setErr('');
    try { await fn(); flash(ok); setV({}); await reload(); } catch (e) { setErr(dxError(e)); } finally { setBusy(''); }
  }
  const save = () => run('save', () => dx.put(`/platforms/${p.key}`, {
    name: val('name'), kind: val('kind'), postUrl: val('postUrl'), maxChars: val('maxChars'), maxTitle: val('maxTitle'), includeSalary: !!val('includeSalary'), expiryDays: val('expiryDays'), formatHint: val('formatHint'), active: !!val('active'),
  }), `${p.name} saved.`);
  return (
    <div className={`dx-edit${val('active') ? '' : ' is-off'}`}>
      <div className="row">
        <label>Name<input value={val('name')} onChange={(e) => set('name', e.target.value)} /></label>
        <label>How it is posted
          <Combo value={val('kind')} disabled={locked} onChange={(e) => set('kind', e.target.value)}>
            {Object.keys(KIND_WORDS).map((k) => <option key={k} value={k}>{KIND_WORDS[k]}</option>)}
          </Combo>
        </label>
        <label>Link to open to post<input value={val('postUrl')} placeholder={locked ? 'Not needed' : 'https://...'} disabled={locked} onChange={(e) => set('postUrl', e.target.value)} /></label>
      </div>
      <div className="row">
        <label>Text limit (characters)<input type="number" min="100" value={val('maxChars')} onChange={(e) => set('maxChars', e.target.value)} /></label>
        <label>Title limit<input type="number" min="20" value={val('maxTitle')} onChange={(e) => set('maxTitle', e.target.value)} /></label>
        <label>Days until it expires<input type="number" min="1" max="365" value={val('expiryDays')} onChange={(e) => set('expiryDays', e.target.value)} /></label>
        <label className="chk" style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" style={{ width: 18, height: 18, minHeight: 0 }} checked={!!val('includeSalary')} onChange={(e) => set('includeSalary', e.target.checked)} /> Show the salary</label>
        <label className="chk" style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" style={{ width: 18, height: 18, minHeight: 0 }} checked={!!val('active')} onChange={(e) => set('active', e.target.checked)} /> In use</label>
      </div>
      <label>How the text should look (a hint people see)<input value={val('formatHint')} onChange={(e) => set('formatHint', e.target.value)} /></label>
      <div className="dx-acts">
        <span className="dx-hint">{MEDIUM_WORDS[p.medium] || p.medium}{p.builtin ? '' : ' · added by you'}</span>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn btn-sm btn-primary" disabled={!dirty || busy === 'save'} onClick={save}>Save</button>
        {p.builtin && <button type="button" className="btn btn-sm" disabled={busy === 'reset'} onClick={() => { if (window.confirm(`Put ${p.name} back to the TeamLink default?`)) run('reset', () => dx.post(`/platforms/${p.key}/reset`), `${p.name} is back to the default.`); }}>Reset</button>}
        {!p.builtin && <button type="button" className="btn btn-sm btn-danger" disabled={busy === 'del'} onClick={() => { if (window.confirm(`Delete ${p.name} from the list?`)) run('del', () => dx.del(`/platforms/${p.key}`), 'Deleted.'); }}>Delete</button>}
      </div>
      {err && <div className="dx-err" role="alert">{err}</div>}
    </div>
  );
}

function GoogleIndexing({ flash }) {
  const [st, setSt] = useState(null);
  const [key, setKey] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const load = useCallback(() => dx.get('/google-indexing').then(setSt).catch((e) => setErr(dxError(e))), []);
  useEffect(() => { load(); }, [load]);
  async function run(k, fn, ok) {
    setBusy(k); setErr('');
    try { await fn(); flash(ok); await load(); } catch (e) { setErr(dxError(e)); } finally { setBusy(''); }
  }
  if (!st) return err ? <div className="dx-err">{err}</div> : null;
  return (
    <section className="jp-card jp-wrap" aria-label="Google Indexing API">
      <div className="jp-row"><h3 style={{ margin: 0 }}>Google Indexing API (optional)</h3><span className="jp-spacer" /><span className={`jp-chip ${st.enabled ? 'jp-green' : 'jp-grey'}`}>{st.enabled ? 'ON' : 'OFF'}</span></div>
      <p className="jp-note" style={{ margin: 0 }}>{st.note}</p>
      <p className="jp-note" style={{ margin: 0 }}>You do not need this for Google for Jobs. Every open requirement page already carries the job markup and is in the site map, and Google finds it by itself. Leave this OFF unless your company has the Google service account.</p>
      {st.configured && <p className="jp-note" style={{ margin: 0 }}>Saved service account: <b>{st.email || 'yes'}</b> (the key is never shown).</p>}
      <label className="jp-field">Paste the service account key file (JSON)
        <textarea rows={4} value={key} onChange={(e) => setKey(e.target.value)} placeholder={st.configured ? 'Leave empty to keep the saved key' : '{ "type": "service_account", ... }'} style={{ font: '12px Consolas,monospace' }} />
      </label>
      <div className="jp-row">
        <button type="button" className="btn btn-primary" disabled={!key.trim() || busy === 'key'} onClick={() => run('key', async () => { await dx.put('/google-indexing', { key }); setKey(''); }, 'The key is saved (switched OFF).')}>Save key</button>
        {st.enabled
          ? <button type="button" className="btn" disabled={busy === 'sw'} onClick={() => run('sw', () => dx.put('/google-indexing', { enabled: false }), 'Switched OFF.')}>Switch OFF</button>
          : <button type="button" className="btn" disabled={!st.configured || busy === 'sw'} onClick={() => { if (window.confirm('Switch ON the Google Indexing API? TeamLink will tell Google about a requirement page only when a person presses "Tell Google" on a requirement.')) run('sw', () => dx.put('/google-indexing', { enabled: true }), 'Switched ON.'); }}>Switch ON</button>}
        {st.configured && <button type="button" className="btn btn-sm btn-danger" disabled={busy === 'rm'} onClick={() => { if (window.confirm('Remove the saved key?')) run('rm', () => dx.del('/google-indexing'), 'The key is removed.'); }}>Remove key</button>}
      </div>
      {err && <div className="dx-err" role="alert">{err}</div>}
    </section>
  );
}

export default function DistPlatformsAdmin() {
  const [list, setList] = useState(null);
  const [settings, setSettings] = useState(null);
  const [notOn, setNotOn] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [add, setAdd] = useState({ name: '', kind: 'semi', postUrl: '', maxChars: '' });
  const [days, setDays] = useState('');
  const load = useCallback(async () => {
    try {
      const d = await dx.get('/platforms', { all: 1 });
      setList(d.platforms || []); setSettings(d.settings); setDays(String(d.settings.reminderDays)); setNotOn(false); setErr('');
    } catch (e) { if (isNotMigrated(e)) setNotOn(true); else setErr(dxError(e)); }
  }, []);
  useEffect(() => { load(); }, [load]);
  if (notOn) return <div className="jp-off" role="status"><b>Distribution is not switched on yet</b><span>{NOT_ON_WORDS}</span></div>;
  const flash = (m) => { setMsg(m); setErr(''); };
  return (
    <div className="jp-wrap">
      <div className="jp-card jp-wrap">
        <h3 style={{ margin: 0 }}>Where requirements are posted</h3>
        <p className="jp-note" style={{ margin: 0 }}>Every place a requirement can go. For each job site TeamLink writes the text for you, gives its own tracking link, and a person posts it. Change a link here if a site moves its page. Switch a place off if you do not use it.</p>
        <div className="jp-row" style={{ alignItems: 'flex-end' }}>
          <label className="jp-field">Remind the team this many days before a post expires
            <input type="number" min="1" max="30" value={days} onChange={(e) => setDays(e.target.value)} style={{ maxWidth: 120 }} />
          </label>
          <button type="button" className="btn btn-sm btn-primary" disabled={!settings || String(settings.reminderDays) === String(days)} onClick={() => dx.put('/settings', { reminderDays: Number(days) }).then(() => { flash('Saved.'); load(); }).catch((e) => setErr(dxError(e)))}>Save</button>
        </div>
        <div role="status" aria-live="polite">{msg && <div className="jp-ok">{msg}</div>}</div>
        {err && <div className="jp-err" role="alert">{err}</div>}
      </div>
      {!list && !err && <div className="jp-note" role="status">Loading...</div>}
      {(list || []).map((p) => <PlaceRow key={`${p.key}${p.updatedAt}`} p={p} reload={load} flash={flash} />)}
      <form className="dx-edit" onSubmit={(e) => {
        e.preventDefault();
        if (!add.name.trim()) { setErr('Type the name of the place.'); return; }
        dx.post('/platforms', add).then(() => { flash(`${add.name} is in the list.`); setAdd({ name: '', kind: 'semi', postUrl: '', maxChars: '' }); load(); }).catch((x) => setErr(dxError(x)));
      }}
      >
        <b>Add a place</b>
        <div className="row">
          <label>Name<input value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} /></label>
          <label>How it is posted
            <Combo value={add.kind} onChange={(e) => setAdd({ ...add, kind: e.target.value })}>{['semi', 'manual'].map((k) => <option key={k} value={k}>{KIND_WORDS[k]}</option>)}</Combo>
          </label>
          <label>Link to open to post<input value={add.postUrl} placeholder="https://..." onChange={(e) => setAdd({ ...add, postUrl: e.target.value })} /></label>
          <label>Text limit<input type="number" min="100" value={add.maxChars} onChange={(e) => setAdd({ ...add, maxChars: e.target.value })} /></label>
        </div>
        <div><button type="submit" className="btn">Add this place</button></div>
      </form>
      <GoogleIndexing flash={flash} />
    </div>
  );
}
