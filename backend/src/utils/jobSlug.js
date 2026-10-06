// ---------------------------------------------------------------------------
// JOB LINKS THAT READ WELL (Save & Post spec §21, 2026-10-05).
//   /careers/software-developer-hyderabad-req-1025
// The slug is worked out from the job (title + first city + Job ID), so it
// needs no column: the Job ID at its end (reqCode, unique) finds the job.
// Old links /careers/<id> keep working — the page moves them to the slug.
// ---------------------------------------------------------------------------
const prisma = require('../db');

const slugPart = (v) => String(v || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function slugOf(r) {
  if (!r) return null;
  const city = String(r.location || '').split(/[,/|]/)[0];
  const words = [slugPart(r.title).split('-').slice(0, 8).join('-'), slugPart(city), slugPart(r.reqCode || '')].filter(Boolean);
  if (!r.reqCode) return r.id; // no Job ID yet: the id is the link
  return words.join('-');
}

// The job for a link: an id, or a slug that ends with its Job ID.
async function findByIdOrSlug(param, args = {}) {
  const p = String(param || '').trim().slice(0, 160);
  if (!p) return null;
  const byId = await prisma.requirement.findUnique({ where: { id: p }, ...args });
  if (byId) return byId;
  const m = /([a-z]+)-(\d+)$/i.exec(p);
  if (!m) return null;
  const r = await prisma.requirement.findUnique({ where: { reqCode: `${m[1].toUpperCase()}-${m[2]}` }, ...args });
  // The words before the Job ID are cosmetic; the Job ID decides.
  return r || null;
}

const careersPath = (r, src) => `/careers/${slugOf(r) || r.id}${src ? `?src=${encodeURIComponent(src)}` : ''}`;

module.exports = { slugOf, findByIdOrSlug, careersPath };
