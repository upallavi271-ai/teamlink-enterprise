import { useEffect, useState } from 'react';
import api from '../../api';
import StatusChip from '../../components/ui/StatusChip.jsx';

// ---------------------------------------------------------------------------
// Administration > Integrations > AI Marketing (founder 2026-11-09: "settings ahh modules kadhu ... omnichannel ki direct ga
// connect avuthundhi"). The outside AI platform that makes the pictures and videos of Omni-Channel > AI Marketing is typed
// here once; TeamLink hands it to Omni-Channel by itself (backend utils/aiMarketingPlatform.js). The key is saved locked
// and never comes back to this screen.
// ---------------------------------------------------------------------------
const KINDS = [['POST', 'Post'], ['STORY', 'Story'], ['BANNER', 'Banner'], ['REEL', 'Reel (video)']];
const WE_SEND = `POST <your address>
Content-Type: application/json
Authorization: Bearer <your key>      (key header and "before the key" as set above)

{
  "kind": "post" | "story" | "banner" | "reel",
  "type": "image" | "video",
  "width": 1080, "height": 1080,      (story/reel 1080x1920, banner 1600x900)
  "seconds": 15,                      (reel only)
  "prompt": "the full brief: what to make, the client's facts, the rules",
  "request": "what the team typed",
  "language": "English" | "Telugu" | "Hindi",
  "client": { "name", "profession", "about", "phone", "whatsapp", "email",
              "website", "address", "logoUrl", "photoUrl", "colors" },
  "test": true                        (only from the Test button)
}`;
const IT_ANSWERS = `Finished (any one):
  { "url": "https://.../file.png" }
  { "base64": "...", "contentType": "image/png" }
  the picture or video itself (Content-Type image/... or video/...)
  also read: mediaUrl, imageUrl, videoUrl, output, data[0].url, data[0].b64_json
  optional: "caption": "...", "hashtags": ["#a", "#b"]  (used when the team gave no words)

Still working (videos):
  { "status": "working", "checkUrl": "https://.../job/123" }
  Omni-Channel asks checkUrl (GET, same key) every 10 seconds, up to 10 minutes

Could not make it:
  HTTP 4xx/5xx, or { "status": "failed", "error": "why" }

Files: PNG or JPEG for post/story/banner, MP4 or WebM for reel.`;

const when = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '');

export default function AiMarketingPlatform() {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [showContract, setShowContract] = useState(false);
  const load = () => api.get('/admin/ai-marketing-platform').then((r) => { setData(r.data); setForm(null); }).catch((e) => setErr(e.response?.data?.error || 'Could not load.'));
  useEffect(() => { load(); }, []);
  if (!data) return <div className="panel"><div style={{ padding: 18 }} className="small-muted">{err || 'Loading…'}</div></div>;
  const now = form || { name: data.name, endpoint: data.endpoint, authHeader: data.authHeader, authPrefix: data.authPrefix, apiKey: '', kinds: data.kinds, enabled: data.enabled };
  const set = (patch) => setForm({ ...now, ...patch });
  const on = data.enabled && data.endpoint && data.kinds.length > 0;

  async function save(extra = {}) {
    setBusy('save'); setMsg(''); setErr('');
    try {
      const body = { ...now, ...extra };
      if (!body.apiKey) delete body.apiKey;
      const r = await api.put('/admin/ai-marketing-platform', body);
      setData(r.data); setForm(null);
      if (r.data.sent && !r.data.sent.ok) setErr(`Saved in TeamLink, but Omni-Channel did not take it yet: ${r.data.sent.words}`);
      else setMsg(r.data.sent ? r.data.sent.words : 'Saved.');
    } catch (e) { setErr(e.response?.data?.error || 'Could not save. Try again.'); } finally { setBusy(''); }
  }
  async function run(path, what) {
    setBusy(what); setMsg(''); setErr('');
    try {
      const r = await api.post(`/admin/ai-marketing-platform/${path}`);
      if (r.data.ok) setMsg(r.data.words); else setErr(r.data.words);
      await load();
    } catch (e) { setErr(e.response?.data?.error || 'It could not run. Try again.'); } finally { setBusy(''); }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h3>AI Marketing platform</h3>
        {on ? <StatusChip tone="green">On: {data.name}</StatusChip> : <StatusChip tone="amber">Off: the built-in designer makes everything</StatusChip>}
        {data.sent && (data.sent.ok ? <StatusChip tone="green">In Omni-Channel</StatusChip> : <StatusChip tone="red">Not in Omni-Channel yet</StatusChip>)}
      </div>
      <div style={{ padding: '8px 18px 16px', display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 860 }}>
        <div className="small-muted">
          Connect any AI platform for better pictures and videos. Omni-Channel &gt; AI Marketing then lets the team pick it in step 2 (Create).
          Everything it makes still goes to the client for approval first.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 10 }}>
          <label className="field" style={{ margin: 0 }}><span>Platform name</span>
            <input value={now.name} maxLength={60} placeholder="The name the team will see" onChange={(e) => set({ name: e.target.value })} />
          </label>
          <label className="field" style={{ margin: 0 }}><span>API address (https)</span>
            <input value={now.endpoint} maxLength={500} placeholder="https://" onChange={(e) => set({ endpoint: e.target.value.trim() })} />
          </label>
          <label className="field" style={{ margin: 0 }}><span>Key header (most platforms: Authorization)</span>
            <input value={now.authHeader} maxLength={60} onChange={(e) => set({ authHeader: e.target.value.trim() })} />
          </label>
          <label className="field" style={{ margin: 0 }}><span>Before the key (most: Bearer and a space; empty if none)</span>
            <input value={now.authPrefix} maxLength={30} onChange={(e) => set({ authPrefix: e.target.value })} />
          </label>
        </div>
        <label className="field" style={{ margin: 0 }}>
          <span>API key {data.keySaved ? `(saved: ${data.keyHint}. Leave empty to keep it)` : '(saved locked, never shown again)'}</span>
          <input type="password" autoComplete="new-password" value={now.apiKey} maxLength={4000} onChange={(e) => set({ apiKey: e.target.value })} />
        </label>
        {data.keySaved && (
          <div><button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => save({ apiKey: '', removeKey: true })}>Remove the saved key</button></div>
        )}
        <div>
          <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 6 }}>It makes</div>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            {KINDS.map(([k, label]) => (
              <label key={k} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13.5 }}>
                <input type="checkbox" style={{ width: 18, height: 18 }} checked={now.kinds.includes(k)} onChange={(e) => set({ kinds: e.target.checked ? [...now.kinds, k] : now.kinds.filter((x) => x !== k) })} /> {label}
              </label>
            ))}
          </div>
        </div>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13.5 }}>
          <input type="checkbox" style={{ width: 18, height: 18 }} checked={now.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> On: the team can use it in Omni-Channel
        </label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button type="button" className="btn btn-primary btn-sm" disabled={!!busy || !form || now.name.trim().length < 2 || !now.endpoint} onClick={() => save()}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
          <button type="button" className="btn btn-sm" disabled={!!busy || !!form || !data.endpoint} onClick={() => run('test', 'test')}>{busy === 'test' ? 'Testing… (up to a minute)' : 'Test'}</button>
          <button type="button" className="btn btn-sm" disabled={!!busy || !!form || !data.endpoint} onClick={() => run('send', 'send')}>{busy === 'send' ? 'Sending…' : 'Send to Omni-Channel again'}</button>
          {form && <span className="small-muted">Save first, then Test.</span>}
        </div>
        {msg && <div style={{ color: 'var(--green, #15803d)', fontSize: 13.5 }}>{msg}</div>}
        {err && <div style={{ color: 'var(--red, #b91c1c)', fontSize: 13.5 }}>{err}</div>}
        {data.lastTest && (
          <div className="small-muted">Last test {when(data.lastTest.at)}: <b style={{ color: data.lastTest.ok ? 'var(--green, #15803d)' : 'var(--red, #b91c1c)' }}>{data.lastTest.words}</b></div>
        )}
        {data.updatedAt && <div className="small-muted">Saved {when(data.updatedAt)}{data.updatedBy ? ` by ${data.updatedBy}` : ''}.</div>}
        <div style={{ border: '1px solid var(--border, #e5e7eb)', borderRadius: 10, padding: 12 }}>
          <button type="button" className="btn btn-sm" onClick={() => setShowContract((v) => !v)}>{showContract ? 'Hide' : 'Show'} what your platform must do</button>
          {showContract && (
            <div style={{ marginTop: 10, fontSize: 12.5 }}>
              <div className="small-muted" style={{ marginBottom: 8 }}>Give this to whoever sets up the platform. If the platform speaks differently, a small in-between service can translate.</div>
              <b>Omni-Channel sends</b>
              <pre style={{ whiteSpace: 'pre-wrap', background: 'var(--surface-2, #f6f7f9)', padding: 10, borderRadius: 8, overflowX: 'auto' }}>{WE_SEND}</pre>
              <b>Your platform answers</b>
              <pre style={{ whiteSpace: 'pre-wrap', background: 'var(--surface-2, #f6f7f9)', padding: 10, borderRadius: 8, overflowX: 'auto' }}>{IT_ANSWERS}</pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
