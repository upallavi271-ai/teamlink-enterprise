import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { loginUrlFor } from '../api';
import HomeRoute from '../pages/home/HomeRoute.jsx';

export default function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();
  const { pathname, search } = useLocation();
  if (loading) return <div className="loading-screen">Loading…</div>;
  if (!user) {
    // A logged-out visitor at exactly "/" gets the public home page in place;
    // every deep link still goes to /login, as before.
    if (pathname === '/') return <HomeRoute />;
    // …and comes back to the page it asked for after signing in.
    return <Navigate to={loginUrlFor(pathname + search)} replace />;
  }
  return children;
}
