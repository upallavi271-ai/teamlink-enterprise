import { createContext, useContext, useEffect, useState } from 'react';
import api, { viewAsToken } from '../api';
import { clearKeptState } from '../utils/useKeptState.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // A View-as tab (components/ViewAs.jsx) signs in with its own token.
    const viewingAs = !!viewAsToken();
    const token = viewAsToken() || localStorage.getItem('tl_token');
    if (!token) {
      setLoading(false);
      return;
    }
    api
      .get('/auth/me')
      .then((res) => setUser(res.data))
      // A failed View-as session is cleaned up by api.js; it must never sign
      // the Super Admin's own login out.
      .catch(() => { if (!viewingAs) localStorage.removeItem('tl_token'); })
      .finally(() => setLoading(false));
  }, []);

  // IDLE SIGN-OUT (backend utils/sessions.js, Profile -> Signed-in devices): no mouse / keyboard / touch for the company's
  // idle minutes -> signed out. The last activity is shared by every tab of this browser, so one busy tab keeps all alive.
  const idleMin = (user && user.security && user.security.idleMinutes) || 0;
  useEffect(() => {
    if (!idleMin || viewAsToken()) return undefined;
    const KEY = 'tl_last_activity';
    const mark = () => { try { localStorage.setItem(KEY, String(Date.now())); } catch { /* storage blocked */ } };
    let lastWrite = 0;
    const onAct = () => { if (Date.now() - lastWrite > 15000) { lastWrite = Date.now(); mark(); } };
    mark();
    const evs = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart'];
    evs.forEach((e) => window.addEventListener(e, onAct, { passive: true }));
    const t = setInterval(() => {
      let last = Date.now();
      try { last = Number(localStorage.getItem(KEY)) || Date.now(); } catch { /* storage blocked */ }
      if (Date.now() - last > idleMin * 60000) {
        const tok = localStorage.getItem('tl_token');
        if (tok) api.post('/auth/logout', null, { headers: { Authorization: `Bearer ${tok}` } }).catch(() => {});
        try { localStorage.removeItem('tl_token'); sessionStorage.setItem('tl_login_notice', `You were signed out after ${idleMin} minutes with no activity. Please sign in again.`); } catch { /* storage blocked */ }
        clearKeptState();
        setUser(null);
      }
    }, 30000);
    return () => { clearInterval(t); evs.forEach((e) => window.removeEventListener(e, onAct)); };
  }, [idleMin]);

  // The login response carries the whole resolved identity — employee record,
  // product access, ATS role, data scope, landing page — plus the permission
  // matrix the server enforces. Nothing here is chosen by the user.
  //
  // Email and password only. When several separate logins share an email AND the same password, the server answers "Choose your
  // account" instead of a session: login() then returns { chooseAccount, selectionToken, accounts } and chooseLogin() finishes the sign-in.
  async function login(email, password) {
    const res = await api.post('/auth/login', { email, password });
    if (res.data.chooseAccount) {
      return { chooseAccount: true, selectionToken: res.data.selectionToken, accounts: res.data.accounts || [], expiresAt: res.data.expiresAt };
    }
    // two-step sign-in (backend routes/mfa.js): the code next, or set it up now under the company rule
    if (res.data.mfaRequired || res.data.mfaEnrolRequired) return { mfa: res.data.mfaRequired ? 'verify' : 'enrol', mfaTicket: res.data.mfaTicket };
    localStorage.setItem('tl_token', res.data.token);
    clearKeptState(); // a new sign-in starts every list fresh (also after a forced sign-out, api.js)
    setUser(res.data.user);
    return res.data.user;
  }

  // The last step of a two-step sign-in: POST /auth/mfa/verify or /auth/mfa/enrol/confirm returns the normal session.
  async function finishMfa(path, body) {
    const res = await api.post(`/auth/mfa/${path}`, body);
    localStorage.setItem('tl_token', res.data.token);
    clearKeptState();
    return { user: res.data.user, recoveryCodes: res.data.recoveryCodes || null, recoveryLeft: res.data.recoveryLeft, commit: () => setUser(res.data.user) };
  }

  async function chooseLogin(selectionToken, choice) {
    const res = await api.post('/auth/login/choose', { selectionToken, choice });
    // A vendor login on the same email was picked: the page signs it in through the vendor sign-in.
    if (res.data.useVendor) return { useVendor: true };
    if (res.data.mfaRequired || res.data.mfaEnrolRequired) return { mfa: res.data.mfaRequired ? 'verify' : 'enrol', mfaTicket: res.data.mfaTicket };
    localStorage.setItem('tl_token', res.data.token);
    clearKeptState(); // a new sign-in starts every list fresh (also after a forced sign-out, api.js)
    setUser(res.data.user);
    return res.data.user;
  }

  // Switch product workspace. Never a role switch: the role does not change.
  async function switchWorkspace(workspace) {
    const res = await api.put('/auth/me/workspace', { workspace });
    setUser(res.data);
    return res.data;
  }

  function logout() {
    // Signing out of a View-as tab ends View as; the Super Admin stays signed in.
    if (viewAsToken()) {
      import('../components/ViewAs.jsx').then((m) => m.exitViewAs());
      return;
    }
    // the Job Portal sessions opened from this sign-in end too (backend/src/utils/jobPortalSso.js); fire and forget
    const signedIn = localStorage.getItem('tl_token'); // read now: the token is gone before an interceptor would run
    if (signedIn) api.post('/sso/job-portal/signout', null, { headers: { Authorization: `Bearer ${signedIn}` } }).catch(() => {});
    // this device's session ends on the server too (Profile -> Signed-in devices shows it as "signed out")
    if (signedIn) api.post('/auth/logout', null, { headers: { Authorization: `Bearer ${signedIn}` } }).catch(() => {});
    localStorage.removeItem('tl_token');
    clearKeptState(); // the lists' kept search / filters / page (utils/useKeptState.js)
    setUser(null);
  }

  // After the person changes their own password: end this session AT ONCE and show the sign-in page with a note, so the next
  // sign-in is with the new password. (The server has already ended the older sessions; the fresh token it hands back is dropped.)
  function endSessionWithNotice(notice) {
    try {
      localStorage.removeItem('tl_token');
      sessionStorage.setItem('tl_login_notice', notice || '');
      clearKeptState();
    } catch { /* storage blocked: the sign-in page still opens, just without the note */ }
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, chooseLogin, finishMfa, logout, endSessionWithNotice, switchWorkspace }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
