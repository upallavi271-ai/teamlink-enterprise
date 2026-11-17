import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import { TeamLinkMark } from '../components/Logo.jsx';

// COMPANY SWITCHER - the page a company's address /bridge opens when TeamLink's Super Admin picks it in the "Companies" menu.
// The signed pass is in the address AFTER the # sign, so it never reaches a server log or another site. It is taken out of the address
// at once, sent once, and the page then opens the company's home. The server decides everything; this page only shows it in words.
export default function CompanyBridge() {
  const [state, setState] = useState({ loading: true });
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    let pass = '';
    try {
      pass = new URLSearchParams((window.location.hash || '').replace(/^#/, '')).get('p') || '';
      window.history.replaceState(null, '', window.location.pathname); // the pass leaves the address bar and the history
    } catch { pass = ''; }
    if (!pass) { setState({ error: 'This page is opened from TeamLink, from the Companies menu.' }); return; }
    api.post('/company-bridge/enter', { pass })
      .then((r) => {
        try { sessionStorage.removeItem('tl_viewas_token'); localStorage.setItem('tl_token', r.data.token); } catch { /* storage blocked */ }
        window.location.replace('/'); // a fresh start, so the whole app loads signed in
      })
      .catch((e) => setState({ error: (e.response && e.response.data && e.response.data.error) || 'Could not sign you in. Please try again from TeamLink.' }));
  }, []);

  return (
    <div className="login-shell"><div className="login-card" style={{ maxWidth: 420 }}>
      <div className="logo-lockup"><TeamLinkMark width={168} /></div>
      {state.loading && <div className="small-muted" style={{ textAlign: 'center', marginTop: 12 }}>Signing you in…</div>}
      {state.error && (
        <>
          <div className="error-text" style={{ margin: '12px 0' }}>{state.error}</div>
          <Link className="btn btn-primary" to="/login" style={{ width: '100%', justifyContent: 'center' }}>Go to sign in</Link>
        </>
      )}
    </div></div>
  );
}
