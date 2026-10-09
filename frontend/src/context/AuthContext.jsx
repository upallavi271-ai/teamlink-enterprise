import { createContext, useContext, useEffect, useState } from 'react';
import api, { viewAsToken } from '../api';

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

  // The login response carries the whole resolved identity — employee record,
  // product access, ATS role, data scope, landing page — plus the permission
  // matrix the server enforces. Nothing here is chosen by the user.
  async function login(email, password) {
    const res = await api.post('/auth/login', { email, password });
    localStorage.setItem('tl_token', res.data.token);
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
    // Ends the sign-in on the server too, and with it the Job Portal session
    // opened from it. The token is dropped here whatever the answer — so it
    // is handed to the call explicitly: axios adds the header asynchronously,
    // after the removeItem below.
    const token = localStorage.getItem('tl_token');
    if (token) api.post('/auth/logout', null, { headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
    localStorage.removeItem('tl_token');
    setUser(null);
  }

  // Once a minute (and when the tab comes back into view), ask whether this
  // sign-in is still alive. A 401 — signed out in the Job Portal, or the
  // shared 30-minute inactivity timeout — goes to the login (api.js). The
  // question carries the idle time, so it never counts as activity itself.
  useEffect(() => {
    if (!user || viewAsToken()) return undefined;
    const check = () => { api.get('/auth/session').catch(() => {}); };
    const t = setInterval(check, 60000);
    const onVisible = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVisible); };
  }, [user]);

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, switchWorkspace }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
