import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import HomeRoute from '../pages/home/HomeRoute.jsx';

export default function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();
  const { pathname } = useLocation();
  if (loading) return <div className="loading-screen">Loading…</div>;
  if (!user) {
    // A logged-out visitor at exactly "/" gets the public home page in place;
    // every deep link still goes to /login, as before.
    if (pathname === '/') return <HomeRoute />;
    return <Navigate to="/login" replace />;
  }
  return children;
}
