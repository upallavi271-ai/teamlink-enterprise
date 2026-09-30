import { useEffect, useState } from 'react';
import api from '../api';

// ---------------------------------------------------------------------------
// TeamLink Job Portal — the stable entry point, and where its URL comes from.
//
// REPLACED (Sep 2026). The portal is no longer the single-file localStorage
// app that used to be served at /job-portal/. It is its own application
// (job-portal-app/: Express + PostgreSQL) on its own origin, and it is really
// connected to this ATS: published requirements are jobs there, and an
// application made there arrives here as a candidate at NEW (backend
// utils/jobPortalBridge.js).
//
// Its address is configuration, not code: JOB_PORTAL_URL in backend/.env
// (default http://localhost:4323), served by GET /api/public/job-portal/config.
// useJobPortalUrl() is what the sidebar link, the Job Portal workspace and the
// requirement page read, so moving the portal to its production domain is one
// setting.
//
// /job-portal and /careers land here and forward to it. The classic careers
// pages (/careers/classic, /careers/:id?src=…, /careers/my-applications) and
// the jobs.xml / jobs.feed feeds are untouched: links already shared keep
// working until they are retired.
// ---------------------------------------------------------------------------
export const DEFAULT_JOB_PORTAL_URL = 'http://localhost:4323';

let cached = null;
let pending = null;

export function loadJobPortalUrl() {
  if (cached) return Promise.resolve(cached);
  if (!pending) {
    pending = api.get('/public/job-portal/config')
      .then((res) => {
        cached = String((res.data && res.data.url) || DEFAULT_JOB_PORTAL_URL).replace(/\/+$/, '');
        return cached;
      })
      .catch(() => { pending = null; return DEFAULT_JOB_PORTAL_URL; });
  }
  return pending;
}

export function useJobPortalUrl() {
  const [url, setUrl] = useState(cached || DEFAULT_JOB_PORTAL_URL);
  useEffect(() => {
    let live = true;
    loadJobPortalUrl().then((u) => { if (live) setUrl(u); });
    return () => { live = false; };
  }, []);
  return url;
}

// A requirement's own page on the portal. The job there is keyed
// tl_<requirement id>; ?src= is recorded by the portal as the application's
// source and comes back here as firstSource (Shine, Naukri, LinkedIn …).
export function jobPortalJobUrl(base, requirementId, src) {
  return `${base}/${src ? `?src=${encodeURIComponent(src)}` : ''}#/job/tl_${requirementId}`;
}

export default function JobPortalRedirect() {
  const url = useJobPortalUrl();
  useEffect(() => {
    // Hard navigation: the portal is another application, not a route here.
    loadJobPortalUrl().then((u) => window.location.replace(`${u}/`));
  }, []);

  return (
    <div className="careers-shell">
      <main className="careers-content">
        <div className="small-muted">Opening the TeamLink Job Portal…</div>
        <p className="small-muted">
          If nothing happens, <a href={`${url}/`}>open the Job Portal</a>.
        </p>
      </main>
    </div>
  );
}
