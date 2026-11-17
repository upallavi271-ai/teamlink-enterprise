import { useEffect, useState } from 'react';
import api from '../api';

// COMPANY SECURITY SETTINGS (backend utils/securityPolicy.js): the password policy and the IP allow-list. Super Admin / Admin
// only (the card hides itself for everybody else: the GET answers 403).
export default function SecurityPolicyCard({ style }) {
  const [d, setD] = useState(null);
  const [pw, setPw] = useState(null);
  const [ipText, setIpText] = useState('');
  const [ipOn, setIpOn] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const load = () => api.get('/auth/security/policy').then((r) => {
    setD(r.data); setPw(r.data.password); setIpText(r.data.ipAllow.entries.join('\n')); setIpOn(r.data.ipAllow.enabled);
  }).catch(() => setD(null));
  useEffect(() => { load(); }, []);
  if (!d || !pw) return null;
  const savePw = async (next) => {
    setErr(''); setMsg('');
    try { const r = await api.put('/auth/security/password-policy', next); setPw(r.data.password); setMsg('Password policy saved. It applies to every new password from now.'); } catch (e) { setErr(e.response?.data?.error || 'Not saved.'); }
  };
  const saveIp = async (enabled) => {
    setErr(''); setMsg('');
    try {
      const r = await api.put('/auth/security/ip-allow', { enabled, entries: ipText.split(/[\s,]+/).filter(Boolean), exemptRoles: d.ipAllow.exemptRoles });
      setIpOn(r.data.ipAllow.enabled); setIpText(r.data.ipAllow.entries.join('\n'));
      setMsg(r.data.ipAllow.enabled ? 'IP allow-list is ON. Staff can sign in only from these addresses (Super Admin always can).' : 'IP allow-list saved (off).');
    } catch (e) { setErr(e.response?.data?.error || 'Not saved.'); }
  };
  const box = (label, k) => (
    <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontWeight: 400, marginRight: 14 }}>
      <input type="checkbox" style={{ width: 'auto' }} checked={!!pw[k]} onChange={(e) => savePw({ ...pw, [k]: e.target.checked })} /> {label}
    </label>
  );
  return (
    <div className="card section" style={style}>
      <h3 style={{ marginTop: 0 }}>Security settings <span className="small-muted" style={{ fontWeight: 400, fontSize: 12 }}>(Super Admin / Admin, for the whole company)</span></h3>
      <b>Password policy</b>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 }}>
        <label style={{ fontWeight: 400 }}>At least{' '}
          <select value={pw.minLength} onChange={(e) => savePw({ ...pw, minLength: Number(e.target.value) })} style={{ width: 'auto' }}>
            {[8, 10, 12, 14, 16].map((n) => <option key={n} value={n}>{n}</option>)}
          </select> characters</label>
        {box('Capital + small letter', 'requireUpper')}
        {box('A symbol', 'requireSymbol')}
      </div>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
        <label style={{ fontWeight: 400 }}>Change every{' '}
          <select value={pw.expiryDays} onChange={(e) => savePw({ ...pw, expiryDays: Number(e.target.value) })} style={{ width: 'auto' }}>
            {[0, 30, 45, 60, 90, 180, 365].map((n) => <option key={n} value={n}>{n ? `${n} days` : 'never'}</option>)}
          </select></label>
        <label style={{ fontWeight: 400 }}>Cannot reuse the last{' '}
          <select value={pw.historyCount} onChange={(e) => savePw({ ...pw, historyCount: Number(e.target.value) })} style={{ width: 'auto' }}>
            {[0, 3, 5, 10].map((n) => <option key={n} value={n}>{n ? `${n} passwords` : '(off)'}</option>)}
          </select></label>
      </div>
      <div className="small-muted" style={{ marginTop: 4 }}>Always on: a letter and a number, not the person&apos;s name or email, not a common password; 5 wrong tries lock the login for 15 minutes.</div>

      <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border, #e5e7eb)' }}>
        <b>IP allow-list</b> <span className="small-muted">— staff can sign in only from these addresses. Clients, candidates and vendors are not affected; a Super Admin always can.</span>
        <div className="small-muted" style={{ marginTop: 4 }}>Your address now: <b>{d.yourIp || 'unknown'}</b></div>
        <textarea rows={4} value={ipText} onChange={(e) => setIpText(e.target.value)} placeholder={'One per line, e.g.\n183.82.4.247\n183.82.4.0/24'} style={{ width: '100%', maxWidth: 420, marginTop: 6, fontFamily: 'monospace' }} />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
          <button type="button" className="btn btn-sm" onClick={() => setIpText((t) => (t.split(/\s+/).includes(d.yourIp) ? t : `${t.trim()}\n${d.yourIp}`.trim()))}>Add my address</button>
          {ipOn ? (
            <>
              <button type="button" className="btn btn-sm btn-primary" onClick={() => saveIp(true)}>Save list</button>
              <button type="button" className="btn btn-sm" onClick={() => saveIp(false)}>Switch off</button>
            </>
          ) : (
            <>
              <button type="button" className="btn btn-sm" onClick={() => saveIp(false)}>Save list (stays off)</button>
              <button type="button" className="btn btn-sm btn-primary" onClick={() => saveIp(true)}>Switch on</button>
            </>
          )}
          <span className="small-muted" style={{ alignSelf: 'center' }}>Now: <b>{ipOn ? 'ON' : 'off'}</b></span>
        </div>
      </div>
      {msg && <div className="notice" style={{ display: 'block', marginTop: 10 }}>{msg}</div>}
      {err && <div className="error-text" style={{ marginTop: 10 }}>{err}</div>}
    </div>
  );
}
