import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The TeamLink Job Portal is a self-contained single-file app that lives at
// frontend/public/job-portal/index.html. It is a *static asset*, never an
// import, so Vite copies it into dist/ verbatim and it never enters the JS
// bundle (it is 1.5MB — bundling it would be a disaster).
//
// The portal routes internally on the URL hash (#/jobs, #/candidate/home, …),
// so serving it from a sub-path needs no <base> rewriting at all.
//
// This plugin only resolves the directory form of the route. Vite's public-dir
// middleware serves "/job-portal/index.html" but does not resolve
// "/job-portal" or "/job-portal/" to it — those would fall through to the SPA
// history fallback and render the React app instead of the portal. Rewriting
// the URL (rather than redirecting) keeps the address bar on /job-portal/.
// frontend/src/App.jsx carries a belt-and-braces redirect for production
// static hosts that behave the same way.
const JOB_PORTAL_FILE = '/job-portal/index.html';

function jobPortalRoute() {
  return {
    name: 'teamlink-job-portal-route',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const [path, query] = (req.url || '').split('?');
        if (path === '/job-portal' || path === '/job-portal/') {
          req.url = JOB_PORTAL_FILE + (query ? `?${query}` : '');
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), jobPortalRoute()],
  server: {
    port: 5183,
    // Defaults to the backend's own default port; override with API_PROXY when
    // running the API somewhere else (e.g. a second checkout on another port).
    proxy: {
      '/api': process.env.API_PROXY || 'http://localhost:4010',
    },
  },
});
