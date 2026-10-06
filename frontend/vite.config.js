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
const OMNICHANNEL_FILE = '/omnichannel/index.html';

function jobPortalRoute() {
  return {
    name: 'teamlink-job-portal-route',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const [path, query] = (req.url || '').split('?');
        // /job-portal is no longer rewritten to the old single-file portal:
        // it falls through to the SPA, whose JobPortalRedirect forwards to the
        // new Job Portal app (JOB_PORTAL_URL, default http://localhost:4323).
        void JOB_PORTAL_FILE;
        // OMNICHANNEL (Green Start, omnichannel-web/ built into
        // public/omnichannel/). It routes on the PATH (/omnichannel/app/…), so
        // every page that is not a real file gets its index.html.
        if (path === '/omnichannel' || (path.startsWith('/omnichannel/') && !/\.[a-z0-9]+$/i.test(path))) {
          req.url = OMNICHANNEL_FILE + (query ? `?${query}` : '');
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
      // THE TEAMLINK JOB PORTAL (job-portal-app/, served by the backend at
      // /jobs — backend utils/jobPortalEmbed.js). The same backend, the same
      // way as /api. The other four are paths the portal uses at the root of
      // the site and this app does not use.
      '^/jobs(/|$)': process.env.API_PROXY || 'http://localhost:4010',
      '/reset-password': process.env.API_PROXY || 'http://localhost:4010',
      '/teamlink-sw.js': process.env.API_PROXY || 'http://localhost:4010',
      '/manifest.webmanifest': process.env.API_PROXY || 'http://localhost:4010',
      // B9.6: the public jobs sitemap + robots.txt are served by the backend.
      '/sitemap.xml': process.env.API_PROXY || 'http://localhost:4010',
      '/robots.txt': process.env.API_PROXY || 'http://localhost:4010',
      '/icons/': process.env.API_PROXY || 'http://localhost:4010',
    },
  },
});
