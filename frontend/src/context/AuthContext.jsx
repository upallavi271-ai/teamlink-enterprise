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
  //
  // Email and password only. When several separate logins share an email AND the same password, the server answers "Choose your
  // account" instead of a session: login() then returns { chooseAccount, selectionToken, accounts } and chooseLogin() finishes the sign-in.
  async function login(email, password) {
    const res = await api.post('/auth/login', { email, password });
    if (res.data.chooseAccount) {
      return { chooseAccount: true, selectionToken: res.data.selectionToken, accounts: res.data.accounts || [], expiresAt: res.data.expiresAt };
    }
    localStorage.setItem('tl_token', res.data.token);
    setUser(res.data.user);
    return res.data.user;
  }

  async function chooseLogin(selectionToken, choice) {
    const res = await api.post('/auth/login/choose', { selectionToken, choice });
    // A vendor login on the same email was picked: the page signs it in through the vendor sign-in.
    if (res.data.useVendor) return { useVendor: true };
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
    localStorage.removeItem('tl_token');
    setUser(null);
  }

  // After the person changes their own password: end this session AT ONCE and show the sign-in page with a note, so the next
  // sign-in is with the new password. (The server has already ended the older sessions; the fresh token it hands back is dropped.)
  function endSessionWithNotice(notice) {
    try {
      localStorage.removeItem('tl_token');
      sessionStorage.setItem('tl_login_notice', notice || '');
    } catch { /* storage blocked: the sign-in page still opens, just without the note */ }
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, chooseLogin, logout, endSessionWithNotice, switchWorkspace }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
