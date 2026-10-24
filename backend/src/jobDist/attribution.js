// ---------------------------------------------------------------------------
// WHERE AN APPLICANT CAME FROM: the tracked link of a platform carries ?src=<key>&utm_source=<key>&utm_medium=...
// This file turns what the link carried back into the platform's own name ("linkedin" -> "LinkedIn", "apna" -> "Apna"),
// so the applicant's source reads "LinkedIn" / "Naukri" / "Apna" and not a code.
//
//   labelFor(raw)   the platform's name for a src / utm_source value, or null when it is not one of ours (sync, never throws)
//   keyFor(raw)     the platform key, or null
//   linkTags(...)   the query tags of one platform's tracked link
//
// Works from the built-in defaults, so it also works before the distribution tables exist; the names an Admin edited are
// merged in when the table can be read (refreshed about once a minute).
// ---------------------------------------------------------------------------
const P = require('./platforms');

const norm = (v) => String(v == null ? '' : v).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '');
const defaults = () => P.DEFAULTS.map((d) => ({ key: d[0], name: d[1], medium: d[3] }));
// The short name an applicant's source reads (the list name is longer: "WhatsApp group / channel"). An Admin's own rename wins.
const SHORT = { whatsapp: 'WhatsApp', telegram: 'Telegram', facebook: 'Facebook', ncs: 'NCS portal', google: 'Google Jobs', college: 'College placement', referral: 'Employee referral' };
const DEFAULT_NAME = Object.fromEntries(P.DEFAULTS.map((d) => [d[0], d[1]]));
const shown = (d) => (SHORT[d.key] && d.name === DEFAULT_NAME[d.key] ? SHORT[d.key] : d.name);

let cache = null; let at = 0; let loading = false;
function table() {
  if (!cache) {
    cache = new Map();
    defaults().forEach((d) => { cache.set(norm(d.key), d); cache.set(norm(d.name), d); if (SHORT[d.key]) cache.set(norm(SHORT[d.key]), d); });
    // short names people also type
    cache.set('website', { key: 'career', name: 'TeamLink Website', medium: 'careers' });
    cache.set('teamlinkwebsite', cache.get('website'));
  }
  if (!loading && Date.now() - at > 60000) {
    loading = true; at = Date.now();
    P.list({ all: true }).then((rows) => {
      if (!rows.length) return;
      const m = new Map(cache);
      rows.forEach((r) => { const d = { key: r.key, name: r.name, medium: r.medium }; m.set(norm(r.key), d); m.set(norm(r.name), d); if (SHORT[r.key]) m.set(norm(SHORT[r.key]), d); });
      cache = m;
    }).catch(() => {}).finally(() => { loading = false; });
  }
  return cache;
}
const forget = () => { cache = null; at = 0; };

const hit = (raw) => { const n = norm(raw); return n ? table().get(n) || null : null; };
const labelFor = (raw) => { const h = hit(raw); return h ? shown(h) : null; };
const keyFor = (raw) => { const h = hit(raw); return h ? h.key : null; };

// The query tags of a platform's tracked link.
function linkTags(platform, job) {
  const code = String((job && (job.reqCode || job.id)) || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return {
    src: platform.key,
    utm_source: platform.key,
    utm_medium: platform.medium || 'job_board',
    utm_campaign: code ? `job-${code}` : 'job',
  };
}

module.exports = { labelFor, keyFor, linkTags, forget, norm };
