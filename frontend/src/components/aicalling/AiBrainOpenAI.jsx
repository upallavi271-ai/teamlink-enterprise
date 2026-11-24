import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import { errorOf } from './aiCallingShared.js';

// Administration > Integrations > AI Calling : the OpenAI key for the AI brain of phone calls (founder 2026-11-24).
//
// It talks to the ordinary Integrations channel "ai-calling-openai" (GET /admin/integrations, PUT .../configure, POST .../test, POST .../disconnect),
// so the key is stored ENCRYPTED on the server and is never sent back: this box only ever learns "a key is saved" and a masked hint.
// A saved, switched-on key makes AI calls think with OpenAI; with none, they use the Claude channel exactly as before (backend/src/utils/openaiCalling.js).
const ID = 'ai-calling-openai';
const KEY = 'OpenAI API key';
const DEFAULT_MODEL = 'gpt-4.1-mini';

export default function AiBrainOpenAI() {
  const [ch, setCh] = useState(null);
  const [key, setKey] = useState('');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [test, setTest] = useState(null);

  const load = useCallback(() => api.get('/admin/integrations')
    .then((r) => {
      const c = (r.data.channels || []).find((x) => x.id === ID) || null;
      setCh(c);
      if (c) setModel((c.values && c.values.Model) || '');
    })
    .catch((e) => setErr(errorOf(e))), []);
  useEffect(() => { load(); }, [load]);

  const hint = ch && ch.secretHints ? ch.secretHints[KEY] : '';
  const saved = !!hint;
  const on = !!(ch && ch.enabled && ch.state !== 'Not Connected');

  async function run(name, fn) {
    setBusy(name); setErr(''); setMsg('');
    try { await fn(); } catch (e) { setErr(errorOf(e)); }
    setBusy('');
  }
  const save = () => run('save', async () => {
    if (!key.trim() && !saved) { setErr('Paste your OpenAI API key first.'); return; }
    await api.put(`/admin/integrations/${ID}/configure`, { values: { [KEY]: key.trim(), Model: model.trim() } });
    setKey(''); setTest(null);
    setMsg(key.trim() ? 'Saved (encrypted). Press Test connection to check it.' : 'Saved.');
    await load();
  });
  const runTest = () => run('test', async () => {
    const r = await api.post(`/admin/integrations/${ID}/test`);
    const text = String(r.data.result || '');
    setTest({ ok: !/^Failed/i.test(text), text });
    await load();
  });
  const turnOff = () => run('off', async () => {
    await api.post(`/admin/integrations/${ID}/disconnect`);
    setTest(null); setMsg('Turned off. AI calls use the Claude channel again. The key stays saved; press Save to turn it back on.');
    await load();
  });
  const removeKey = () => run('remove', async () => {
    if (!window.confirm('Erase the saved OpenAI key? AI calls will use the Claude channel again.')) return;
    await api.put(`/admin/integrations/${ID}/configure`, { values: { [KEY]: '-', Model: model.trim() || DEFAULT_MODEL } });
    await api.post(`/admin/integrations/${ID}/disconnect`);
    setKey(''); setTest(null); setMsg('The key was erased.');
    await load();
  });

  return (
    <div className="panel panel-pad">
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <h3 style={{ fontSize: 14, margin: 0 }}>AI brain: OpenAI key (optional)</h3>
        <span className={`status ${saved && on ? 'active' : saved ? 'pending' : 'new'}`}>{saved ? (on ? 'In use' : 'Saved, turned off') : 'No key saved'}</span>
      </div>
      <div className="small-muted" style={{ margin: '4px 0 10px' }}>
        With an OpenAI key saved, the AI on each phone call understands the candidate&apos;s answer and replies in a natural way using OpenAI. The call flow, the honesty rules and the
        fixed script do not change, and if OpenAI is slow or fails the call just carries on with the script. With no key, AI calls keep using the Claude channel (Integrations &gt; AI Assistant)
        exactly as before. Get a key at platform.openai.com &gt; API keys (the account needs credit).
      </div>
      {!ch && !err && <div className="small-muted">Loading…</div>}
      {ch && (
        <>
          <div className="grid-2">
            <div className="field">
              <label>OpenAI API key · stored encrypted, never shown again</label>
              <input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={saved ? `Saved ${hint} · leave empty to keep it` : 'sk-...'} />
            </div>
            <div className="field">
              <label>Model (leave empty for {DEFAULT_MODEL})</label>
              <input type="text" value={model} onChange={(e) => setModel(e.target.value)} placeholder={DEFAULT_MODEL} />
              <div className="small-muted">Any OpenAI chat model that can return structured answers. A fast one suits a phone call.</div>
            </div>
          </div>
          <div className="row-actions">
            <button type="button" className="btn btn-primary" disabled={!!busy} onClick={save}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
            <button type="button" className="btn" disabled={!!busy || !saved} onClick={runTest}>{busy === 'test' ? 'Testing…' : 'Test connection'}</button>
            <button type="button" className="btn" disabled={!!busy || !saved || !on} onClick={turnOff}>Turn off</button>
            <button type="button" className="btn" disabled={!!busy || !saved} onClick={removeKey}>Erase key</button>
          </div>
          {ch.lastTestResult && !test && <div className="small-muted" style={{ marginTop: 6 }}>Last test{ch.lastTest ? ` (${ch.lastTest})` : ''}: {ch.lastTestResult}</div>}
        </>
      )}
      {err && <div className="error-text" role="alert" style={{ marginTop: 8 }}>{err}</div>}
      {msg && <div className="notice" style={{ marginTop: 8 }}>{msg}</div>}
      {test && <div className={`notice${test.ok ? '' : ' red'}`} style={{ marginTop: 8, display: 'block' }}>{test.text}</div>}
    </div>
  );
}
