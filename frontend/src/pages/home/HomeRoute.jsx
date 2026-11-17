import { lazy, Suspense } from 'react';
import { Navigate } from 'react-router-dom';
import { BRAND } from '../../brand.js';

// The public home page, loaded on demand: a signed-in user who never sees it
// never downloads it (or its stylesheet). Used by ProtectedRoute for a
// logged-out "/" and by the explicit "/home" route in App.jsx.
const Home = lazy(() => import('./Home.jsx'));

export default function HomeRoute() {
  // A separate company's copy (frontend/src/brand.js) has no public TeamLink marketing page: its address opens the sign-in page.
  if (BRAND.separate) return <Navigate to="/login" replace />;
  return (
    <Suspense fallback={<div className="loading-screen">Loading…</div>}>
      <Home />
    </Suspense>
  );
}
