import { useEffect } from 'react';
import { useParams } from 'react-router-dom';

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
//
// BUILT IN (2026-10-05). The separate portal is retired: the job portal is
// this app's own /careers pages (pages/careers/), on this site and this
// database. The helpers below keep their names (the sidebar link, the
// Integrations screen and the requirement page use them) but now always
// point here: <this site>/careers and /careers/<requirement id>?src=….
// Nothing redirects to another port any more.
//
// EMBEDDED (2026-10-05, later the same day). The customer's own Job Portal
// (job-portal-app/job_portal-main, unchanged) is served by THIS site at /jobs:
// the backend starts it and proxies to it (backend utils/jobPortalEmbed.js),
// and utils/jobPortalBridge.js keeps it in step with the ATS within seconds.
// The helpers keep their names; /job-portal and /careers land on /jobs.
// ---------------------------------------------------------------------------
const embedded = () => `${typeof window !== 'undefined' ? window.location.origin : ''}/jobs`;
export const DEFAULT_JOB_PORTAL_URL = embedded();

export function loadJobPortalUrl() {
  return Promise.resolve(embedded());
}

export function useJobPortalUrl() {
  return embedded();
}

// A requirement's own page on the portal: /jobs/#/job/tl_<id>. ?src= is read
// by the portal and recorded on the application (Shine, Naukri, LinkedIn …).
export function jobPortalJobUrl(base, requirementId, src) {
  return `${base || embedded()}/${src ? `?src=${encodeURIComponent(src)}` : ''}#/job/tl_${encodeURIComponent(requirementId)}`;
}

// Old links -> the portal at /jobs. /jobs is not a React page, so this is a
// full page load, not a router navigation.
//   /job-portal, /careers           -> /jobs/ (?src= kept)
//   /careers/my-applications        -> /jobs/#/candidate/applications
//   /careers/<requirement id|slug>  -> that job on the portal (the server
//                                      resolves the slug: /api/public/job-portal/go/…)
export default function JobPortalRedirect() {
  const { id } = useParams();
  useEffect(() => {
    const qs = window.location.search || '';
    if (id === 'my-applications') window.location.replace('/jobs/#/candidate/applications');
    else if (id) window.location.replace(`/api/public/job-portal/go/${encodeURIComponent(id)}${qs}`);
    else window.location.replace(`/jobs/${qs}`);
  }, [id]);
  return null;
}
