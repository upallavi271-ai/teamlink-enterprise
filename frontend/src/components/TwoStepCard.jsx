import { useEffect, useState } from 'react';
import api from '../api';

// TWO-STEP SIGN-IN (backend routes/mfa.js): turn it on with an authenticator app, keep the recovery codes, turn it off.
// Super Admin / Admin also see the company rule: which roles must use it.
const ROLE_NAMES = {
  SUPER_ADMIN: 'Super Admin', ADMIN: 'Admin', MANAGER: 'Manager', ASSISTANT_MANAGER: 'Asst Manager', HR: 'HR', STL: 'STL', TL: 'TL',
  BDE: 'BDE', ACCOUNTANT: 'Accountant', RECRUITER: 'Recruiter', EMPLOYEE: 'Employee',
};

export function RecoveryCodes({ codes }) {
  if (!codes || !codes.length) return null;
  const text = codes.join('\n');
  return (
    <div className="notice" style={{ display: 'block', marginTop: 10 }}>
      <b>Save these 10 recovery codes now.</b> Each works once if you lose your phone. They are not shown again.
      <pre style={{ margin: '8px 0', fontSize: 14, letterSpacing: 1, columns: 2, background: 'var(--surface-2, #f6f7f9)', padding: 8, borderRadius: 6 }}>{text}</pre>
      <button type="button" className="btn btn-sm" onClick={() => { try { navigator.clipboard.writeText(text); } catch { /* blocked */ } }}>Copy</button>
      {' '}
      <button type="button" className="btn btn-sm" onClick={() => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([`TeamLink two-step recovery codes\n\n${text}\n`], { type: 'text/plain' })); a.download = 'teamlink-recovery-codes.txt'; a.click(); }}>Download</button>
    </div>
  );
}

export function SetupBox({ setup, code, setCode }) {
  return (
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start', marginTop: 10 }}>
      {setup.qrSvg && <div style={{ width: 180, height: 180, background: '#fff', padding: 6, borderRadius: 8 }} dangerouslySetInnerHTML={{ __html: setup.qrSvg }} aria-label="QR code for your authenticator app" />}
      <div style={{ flex: '1 1 220px', minWidth: 0 }}>
        <div>1. Open Google Authenticator, Microsoft Authenticator or Authy and scan the QR.</div>
        <div className="small-muted" style={{ margin: '4px 0' }}>Can&apos;t scan? Add a key by hand: <b style={{ fontFamily: 'monospace', overflowWrap: 'anywhere' }}>{setup.secret}</b></div>
        <div style={{ marginTop: 8 }}>2. Type the 6-digit code the app shows:</div>
        <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="123456" aria-label="6-digit code" style={{ width: 130, fontSize: 18, letterSpacing: 3, marginTop: 4 }} />
      </div>
    </div>
  );
}

export default function TwoStepCard({ style }) {
  const [s, setS] = useState(null);
  const [mode, setMode] = useState(''); // '' | 'start' | 'setup' | 'off' | 'newcodes'
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [setup, setSetup] = useState(null);
  const [codes, setCodes] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [policy, setPolicy] = useState(null);
  const load = () => api.get('/auth/mfa/status').then((r) => {
    setS(r.data);
    if (r.data.canManage) api.get('/auth/mfa/policy').then((p) => setPolicy(p.data)).catch(() => {});
  }).catch(() => setS(null));
  useEffect(() => { load(); }, []);
  if (!s) return null;
  const reset = () => { setMode(''); setPassword(''); setCode(''); setSetup(null); setErr(''); };
  const run = async (fn) => { setBusy(true); setErr(''); try { await fn(); } catch (e) { setErr(e.response?.data?.error || 'That did not work. Try again.'); } finally { setBusy(false); } };

  return (
    <div className="card section" style={style}>
      <h3 style={{ marginTop: 0 }}>Two-step sign-in</h3>
      <div className="small-muted" style={{ marginBottom: 8 }}>
        After your password, TeamLink asks for a 6-digit code from an app on your phone, so a stolen password alone cannot open your login.
      </div>
      <div>Status: <b>{s.enabled ? `On since ${new Date(s.enabledAt).toLocaleDateString('en-GB')}` : 'Off'}</b>
        {s.enabled && <span className="small-muted"> · {s.recoveryLeft} recovery code{s.recoveryLeft === 1 ? '' : 's'} left</span>}
        {s.required && <span className="small-muted"> · compulsory for your role</span>}
      </div>
      <RecoveryCodes codes={codes} />

      {!s.enabled && mode === '' && <button type="button" className="btn btn-primary" style={{ marginTop: 10 }} onClick={() => { setCodes(null); setMode('start'); }}>Turn on</button>}
      {mode === 'start' && (
        <form style={{ marginTop: 10 }} onSubmit={(e) => { e.preventDefault(); run(async () => { const r = await api.post('/auth/mfa/start', { password }); setSetup(r.data); setMode('setup'); }); }}>
          <label htmlFor="tsPw">Your current password</label>
          <input id="tsPw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} style={{ maxWidth: 260 }} />
          <div style={{ marginTop: 8 }}><button className="btn btn-primary" disabled={busy || !password}>Next</button> <button type="button" className="btn" onClick={reset}>Cancel</button></div>
        </form>
      )}
      {mode === 'setup' && setup && (
        <form onSubmit={(e) => { e.preventDefault(); run(async () => { const r = await api.post('/auth/mfa/confirm', { code }); setCodes(r.data.recoveryCodes); reset(); await load(); }); }}>
          <SetupBox setup={setup} code={code} setCode={setCode} />
          <div style={{ marginTop: 10 }}><button className="btn btn-primary" disabled={busy || code.length !== 6}>Turn on</button> <button type="button" className="btn" onClick={reset}>Cancel</button></div>
        </form>
      )}
      {s.enabled && mode === '' && (
        <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn" onClick={() => { setCodes(null); setMode('newcodes'); }}>New recovery codes</button>
          {!s.required && <button type="button" className="btn" onClick={() => { setCodes(null); setMode('off'); }}>Turn off</button>}
        </div>
      )}
      {mode === 'newcodes' && (
        <form style={{ marginTop: 10 }} onSubmit={(e) => { e.preventDefault(); run(async () => { const r = await api.post('/auth/mfa/recovery', { code }); setCodes(r.data.recoveryCodes); reset(); await load(); }); }}>
          <label htmlFor="tsNc">Code from your app (the old recovery codes stop working)</label>
          <input id="tsNc" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} style={{ width: 130 }} />
          <div style={{ marginTop: 8 }}><button className="btn btn-primary" disabled={busy || code.length !== 6}>Make new codes</button> <button type="button" className="btn" onClick={reset}>Cancel</button></div>
        </form>
      )}
      {mode === 'off' && (
        <form style={{ marginTop: 10 }} onSubmit={(e) => { e.preventDefault(); run(async () => { await api.post('/auth/mfa/disable', { password, code }); reset(); await load(); }); }}>
          <label htmlFor="tsOffPw">Your password</label>
          <input id="tsOffPw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} style={{ maxWidth: 260 }} />
          <label htmlFor="tsOffCode" style={{ marginTop: 6 }}>Code from your app</label>
          <input id="tsOffCode" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} style={{ width: 130 }} />
          <div style={{ marginTop: 8 }}><button className="btn btn-danger" disabled={busy || !password || code.length !== 6}>Turn off</button> <button type="button" className="btn" onClick={reset}>Cancel</button></div>
        </form>
      )}
      {err && <div className="error-text" style={{ marginTop: 8 }}>{err}</div>}

      {s.canManage && policy && (
        <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border, #e5e7eb)' }}>
          <b>Company rule</b> <span className="small-muted">(Super Admin / Admin): two-step sign-in is compulsory for</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px', marginTop: 6 }}>
            {policy.choices.map((r) => (
              <label key={r} style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontWeight: 400 }}>
                <input type="checkbox" style={{ width: 'auto' }} checked={policy.roles.includes(r)}
                  onChange={(e) => { const roles = e.target.checked ? [...policy.roles, r] : policy.roles.filter((x) => x !== r); run(async () => { const p = await api.put('/auth/mfa/policy', { roles }); setPolicy({ ...policy, roles: p.data.roles }); }); }} />
                {ROLE_NAMES[r] || r}
              </label>
            ))}
          </div>
          <div className="small-muted" style={{ marginTop: 4 }}>A login of a ticked role that has not set it up is asked to set it up at its next sign-in. Lost phone: Administration → Users → Reset two-step.</div>
        </div>
      )}
    </div>
  );
}
