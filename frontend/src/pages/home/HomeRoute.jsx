import { lazy, Suspense } from 'react';

// The public home page, loaded on demand: a signed-in user who never sees it
// never downloads it (or its stylesheet). Used by ProtectedRoute for a
// logged-out "/" and by the explicit "/home" route in App.jsx.
const Home = lazy(() => import('./Home.jsx'));

export default function HomeRoute() {
  return (
    <Suspense fallback={<div className="loading-screen">Loading…</div>}>
      <Home />
    </Suspense>
  );
}
