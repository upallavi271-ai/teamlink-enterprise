import { useEffect, useState } from 'react';
import api from '../../api';

// ---------------------------------------------------------------------------
// SINGLE SIGN-ON on the login page (market wave 15.01): one "Sign in with ..." button per provider an Admin switched on
// (Administration -> ATS settings -> Integrations -> Single sign-on), and the /sso/callback page that collects the session.
// Backend: utils/atsPlus/sso.js. No provider switched on = nothing is drawn.
// ---------------------------------------------------------------------------
export function SsoButtons() {
  const [list, setList] = useState([]);
  const [err] = useState(() => { try { return new URLSearchParams(window.location.search).get('sso_error') || ''; } catch { return ''; } });
  useEffect(() => { api.get('/sso/providers').then((r) => setList(r.data.providers || [])).catch(() => setList([])); }, []);
  if (!list.length && !err) return null;
  return (
    <div style={{ marginTop: 14 }}>
      {err && <div className="error-text" style={{ marginBottom: 8 }}>{err}</div>}
      {list.map((p) => (
        <button key={p.id} type="button" className="btn" style={{ width: '100%', justifyContent: 'center', marginTop: 6 }}
          onClick={() => { window.location.href = `/api/sso/${p.id}/start`; }}>
          Sign in with {p.name}
        </button>
      ))}
    </div>
  );
}

export function SsoCallback() {
  const [msg, setMsg] = useState('Signing you in…');
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const call = q.get('ticket') ? api.post('/sso/finish', { ticket: q.get('ticket') }) : api.post('/sso/oidc/finish', { code: q.get('code'), state: q.get('state') });
    call.then((r) => {
      if (!r.data || !r.data.token) { setMsg('The sign-in did not finish. Try again from the login page.'); return; }
      localStorage.setItem('tl_token', r.data.token);
      window.location.replace('/');
    }).catch((e) => setMsg((e.response && e.response.data && e.response.data.error) || 'The sign-in did not finish. Try again from the login page.'));
  }, []);
  return <div className="careers-shell"><main className="ofs-page"><div className="notice" role="status">{msg}</div><a href="/login">Back to the login page</a></main></div>;
}
