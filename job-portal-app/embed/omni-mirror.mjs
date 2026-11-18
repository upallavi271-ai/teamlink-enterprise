/*
 * THE PORTAL'S "Templates & Campaigns" ALSO SHOWS WHAT WAS MADE IN OMNI-CHANNEL (2026-11-18).
 * GET /api/comm/templates and /api/comm/campaigns are answered by the portal as before; this middleware (in front of them) adds the
 * Omni-Channel WhatsApp templates / campaigns the signed-in recruiter may see - asked of TeamLink with the bridge secret and the
 * recruiter's e-mail (backend/src/routes/jobPortalBridge.js /omni-templates, /omni-campaigns). Read-only rows (source "omni"). If TeamLink
 * does not answer, the portal's own list is sent unchanged.
 */
import { cookieOf } from './kavya-campaign.mjs';

export function omniMirror(kind, deps) {
  const path = kind === 'templates' ? 'omni-templates' : 'omni-campaigns';
  return async function mirrorMiddleware(req, res, next) {
    try {
      const q = req.query || {};
      if (q.channel && q.channel !== 'whatsapp') return next();
      if (String(q.archived) === 'true') return next();
      const token = cookieOf(req.headers && req.headers.cookie, process.env.SESSION_COOKIE || 'tl_session');
      const session = token ? await deps.resolveSession(token) : null;
      if (!session || !deps.secret) return next();
      const email = await deps.emailOf(session);
      if (!email) return next();
      const doFetch = deps.fetchFn || fetch;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 6000);
      let rows = [];
      try {
        const r = await doFetch(`${String(deps.api).replace(/\/+$/, '')}/api/public/job-portal/${path}`, {
          signal: ctl.signal, headers: { 'x-job-portal-secret': deps.secret, 'x-portal-user-email': email },
        });
        const out = await r.json().catch(() => ({}));
        rows = r.ok ? (out[kind] || []) : [];
      } catch { rows = []; } finally { clearTimeout(timer); }
      const needle = String(q.q || '').trim().toLowerCase();
      rows = rows.filter((x) => (!needle || `${x.name} ${x.body || ''}`.toLowerCase().includes(needle))
        && (!q.department || x.department === q.department)
        && (!q.approval || kind !== 'templates' || x.approval === q.approval));
      if (!rows.length) return next();
      const orig = res.json.bind(res);
      res.json = (body) => {
        if (body && Array.isArray(body[kind])) {
          const seen = new Set(body[kind].map((x) => x.id));
          const merged = { ...body, [kind]: [...rows.filter((x) => !seen.has(x.id)), ...body[kind]] };
          if (kind === 'templates') merged.departments = [...new Set([...(body.departments || []), ...rows.map((x) => x.department).filter(Boolean)])].sort();
          return orig(merged);
        }
        return orig(body);
      };
      return next();
    } catch { return next(); }
  };
}

/** The portal's WhatsApp templates, for TeamLink's Omni-Channel hub. */
export async function portalWhatsAppTemplates(withUser, SYSTEM) {
  const rows = await withUser(SYSTEM, async (c) => (await c.query(
    `select id, name, subject, body, department, approval_state, wa_name, wa_language, created_by_name, updated_at
       from comm_templates where kind = 'whatsapp' and not archived order by updated_at desc limit 500`)).rows);
  return rows.map((t) => ({
    id: t.id, name: t.name, subject: t.subject || '', body: t.body || '', department: t.department || '', approval: t.approval_state,
    waName: t.wa_name || '', language: t.wa_language || '', createdBy: t.created_by_name || '', updatedAt: t.updated_at,
  }));
}

/** Approved WhatsApp templates from TeamLink -> the portal's comm_templates (so Send WhatsApp Message lists them). One bad row never stops the rest. */
export async function receiveWhatsAppTemplates(withUser, SYSTEM, list) {
  let done = 0; const failed = [];
  for (const t of (Array.isArray(list) ? list : []).slice(0, 300)) {
    try {
      const wa = { category: 'utility', header: { type: 'none' }, footer: null, buttons: [], params: Array.isArray(t.params) ? t.params : [], fallbacks: {}, syncedAt: new Date().toISOString(), from: 'TeamLink Omni-Channel' };
      // eslint-disable-next-line no-await-in-loop
      await withUser(SYSTEM, (c) => c.query('select * from comm_template_wa_upsert($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::text[],$10,$11)',
        [String(t.id), String(t.waName), String(t.language), String(t.name), String(t.body), JSON.stringify(wa), 'approved', t.department || null, t.usedIn || ['Omni-Channel'], 'portal', 'TeamLink Omni-Channel']));
      done += 1;
    } catch (err) { failed.push({ name: t && t.name, reason: String((err && err.message) || err).slice(0, 160) }); }
  }
  return { ok: true, saved: done, failed };
}
