import { createContext, useContext, useEffect, useState } from 'react';
import api from '../api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('tl_token');
    if (!token) {
      setLoading(false);
      return;
    }
    api
      .get('/auth/me')
      .then((res) => setUser(res.data))
      .catch(() => localStorage.removeItem('tl_token'))
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
    localStorage.removeItem('tl_token');
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, switchWorkspace }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
