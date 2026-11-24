// ---------------------------------------------------------------------------
// CRM WAVE B - MARKETING (13.02 13.03 13.04 13.05 13.06 13.07 13.08 13.09 13.10)
//   segments       saved filters over leads or contacts; worked out again every time they are used (self-updating); a campaign, a journey
//                  and the power dialer can use one
//   landing pages  a page with a headline, words and a form, hosted by TeamLink at /api/crm-public/b/p/<slug> (or put on any website in an
//                  iframe); a form sent makes a lead, with the page as its campaign
//   campaign ROI   per campaign: cost, opens / clicks, the leads it brought (utm_campaign = its code, or a landing page of it), the people
//                  it reached who were won later, the value won, return on the money spent
//   social         posts to the company Facebook Page / LinkedIn (the accounts in Administration > Integrations > Social Media): "Post now"
//                  by a person, or at a time (switch "Social posts"); social profile links on a lead
//   web visits     a small script on the company website records the pages a visitor opens (switch "Website visit tracking"); once the
//                  visitor fills a form / chats / gives an email, their pages show on the lead
//   journeys       several nurture journeys (email / WhatsApp / SMS / a follow-up task, days apart) for new leads of a source or for the
//                  members of a segment; a reply, an opt-out or a won / lost lead stops it (switch "Nurture journeys" + each journey's own On)
//   ads            Facebook / Instagram lead ads (webhook + the Page token) and Google Ads lead forms (webhook + key) come in as leads
//                  (switch "Ad leads"); a segment downloads as a hashed Customer Match / Custom Audience file
//   events         webinars / events with a public registration page; a registration is a lead; attended / no-show
//   preferences    the preference centre behind every campaign email: the topics a person wants, the channels, or nothing at all
// ---------------------------------------------------------------------------
const C = require('./common');

const { S, B, clip, json, esc } = C;

// ================================================================== 13.02 segments
const SEG_FIELDS = ['status', 'stage', 'source', 'rating', 'city', 'industry', 'owner', 'createdDays', 'idleDays', 'hasEmail', 'hasPhone', 'role', 'accountKind', 'campaign', 'eventId'];
function cleanFilters(f = {}) {
  const o = {};
  for (const k of SEG_FIELDS) {
    const v = f[k];
    if (v === undefined || v === null || v === '') continue; // eslint-disable-line no-continue
    o[k] = ['createdDays', 'idleDays'].includes(k) ? Math.max(1, Math.min(3650, Math.round(Number(v)) || 0)) || undefined : (['hasEmail', 'hasPhone'].includes(k) ? v === true || v === '1' || v === 'true' : clip(v, 80));
  }
  return o;
}
async function segmentQuery(user, audience, f) {
  const r = C.role(user);
  const where = []; const params = [];
  if (!S.seesAll(r)) { where.push('x."ownerId" = ?'); params.push(user.id); } else if (f.owner) { where.push('x."ownerId" = ?'); params.push(f.owner); }
  if (f.createdDays) { where.push('x."createdAt" >= ?'); params.push(new Date(Date.now() - f.createdDays * 86400000).toISOString()); }
  if (audience === 'contacts') {
    if (f.role) { where.push('x."role" = ?'); params.push(f.role); }
    if (f.accountKind) { where.push('a."kind" = ?'); params.push(f.accountKind); }
    if (f.city) { where.push('a."city" LIKE ?'); params.push(`%${f.city}%`); }
    if (f.industry) { where.push('a."industry" LIKE ?'); params.push(`%${f.industry}%`); }
    if (f.hasEmail) where.push('x."email" IS NOT NULL AND x."email" != \'\'');
    if (f.hasPhone) where.push('x."phone" IS NOT NULL AND x."phone" != \'\'');
    if (f.idleDays) { where.push('NOT EXISTS (SELECT 1 FROM "CrmActivity" t WHERE t."contactId" = x."id" AND t."at" >= ?)'); params.push(new Date(Date.now() - f.idleDays * 86400000).toISOString()); }
    return B.all(`SELECT 'contact' AS "kind", x."id", x."name", a."name" AS "company", x."email", x."phone", a."city", x."ownerId" FROM "CrmContact" x LEFT JOIN "CrmAccount" a ON a."id" = x."accountId" WHERE ${where.join(' AND ') || '1=1'} LIMIT 5001`, ...params);
  }
  if (f.status === 'all') { /* every lead */ } else if (f.status) { where.push('x."status" = ?'); params.push(f.status); } else where.push('x."status" NOT IN (\'Converted\', \'Junk\')');
  if (f.stage) { where.push('x."stage" = ?'); params.push(f.stage); }
  if (f.source) { where.push('x."source" = ?'); params.push(f.source); }
  if (f.rating) { where.push('x."rating" = ?'); params.push(f.rating); }
  if (f.city) { where.push('x."city" LIKE ?'); params.push(`%${f.city}%`); }
  if (f.industry) { where.push('x."industry" LIKE ?'); params.push(`%${f.industry}%`); }
  if (f.campaign) { where.push('(x."utmCampaign" = ? OR x."campaignId" = ?)'); params.push(f.campaign, f.campaign); }
  if (f.eventId) { where.push('x."id" IN (SELECT "leadId" FROM "CrmMktEventReg" WHERE "eventId" = ?)'); params.push(f.eventId); }
  if (f.hasEmail) where.push('x."email" IS NOT NULL AND x."email" != \'\'');
  if (f.hasPhone) where.push('x."phone" IS NOT NULL AND x."phone" != \'\'');
  if (f.idleDays) { where.push('NOT EXISTS (SELECT 1 FROM "CrmActivity" t WHERE t."leadId" = x."id" AND t."at" >= ?)'); params.push(new Date(Date.now() - f.idleDays * 86400000).toISOString()); }
  return B.all(`SELECT 'lead' AS "kind", x."id", x."contactName" AS "name", x."company", x."email", x."phone", x."city", x."ownerId" FROM "CrmLead" x WHERE ${where.join(' AND ') || '1=1'} LIMIT 5001`, ...params);
}
async function segments(user) {
  const rows = await B.all('SELECT * FROM "CrmMktSegment" ORDER BY "name" COLLATE NOCASE');
  return S.okBody({ segments: rows.map((s) => ({ ...s, filters: json(s.filtersJson, {}) })), fields: SEG_FIELDS, canEdit: C.isManager(user) || C.canWork(user) });
}
async function saveSegment(user, id, body = {}) {
  const no = C.needWork(user); if (no) return no;
  const name = clip(body.name, 120);
  if (!name) return S.fail(400, 'Give the segment a name.');
  const audience = body.audience === 'contacts' ? 'contacts' : 'leads';
  const f = cleanFilters(body.filters);
  const now = B.nowIso();
  const count = (await segmentQuery(user, audience, f)).length;
  if (id) {
    const s = await B.one('SELECT * FROM "CrmMktSegment" WHERE "id" = ?', String(id).slice(0, 60));
    if (!s || !(s.ownerId === user.id || C.isManager(user))) return S.fail(404, 'This segment is not there, or it is not yours.');
    await B.run('UPDATE "CrmMktSegment" SET "name" = ?, "audience" = ?, "filtersJson" = ?, "lastCount" = ?, "lastCountAt" = ?, "updatedAt" = ? WHERE "id" = ?', name, audience, JSON.stringify(f), count, now, now, s.id);
    return S.okBody({ ok: true, id: s.id, count });
  }
  const sid = C.newId('seg');
  await B.run('INSERT INTO "CrmMktSegment" ("id","name","audience","filtersJson","ownerId","lastCount","lastCountAt","byId","byName","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?,?)', sid, name, audience, JSON.stringify(f), user.id, count, now, user.id, user.name || null, now, now);
  return S.okBody({ ok: true, id: sid, count });
}
async function removeSegment(user, id) {
  const s = await B.one('SELECT * FROM "CrmMktSegment" WHERE "id" = ?', String(id || '').slice(0, 60));
  if (!s || !(s.ownerId === user.id || C.isManager(user))) return S.fail(404, 'This segment is not there, or it is not yours.');
  await B.run('DELETE FROM "CrmMktSegment" WHERE "id" = ?', s.id);
  return S.okBody({ ok: true });
}
async function segmentRows(user, id) {
  const s = await B.one('SELECT * FROM "CrmMktSegment" WHERE "id" = ?', String(id || '').slice(0, 60));
  if (!s) return { error: S.fail(404, 'This segment is not there.') };
  const rows = await segmentQuery(user, s.audience, json(s.filtersJson, {}));
  await B.run('UPDATE "CrmMktSegment" SET "lastCount" = ?, "lastCountAt" = ? WHERE "id" = ?', rows.length, B.nowIso(), s.id);
  return { segment: s, rows };
}
async function segmentPreview(user, { audience, filters, id } = {}) {
  if (id) { const g = await segmentRows(user, id); if (g.error) return g.error; return S.okBody({ count: g.rows.length, sample: g.rows.slice(0, 10) }); }
  const rows = await segmentQuery(user, audience === 'contacts' ? 'contacts' : 'leads', cleanFilters(filters));
  return S.okBody({ count: rows.length, sample: rows.slice(0, 10) });
}
// a campaign whose audience is a segment (crm/campaigns.js audienceRows hands it here): the same shape as its own audience rows
async function segmentAudience(user, id) {
  const g = await segmentRows(user, id);
  if (g.error) return [];
  return g.rows.map((x) => ({ id: x.id, name: x.name, company: x.company, email: x.email, phone: x.phone, city: x.city }));
}
// 13.08 a segment as a hashed file for Google Customer Match / Meta Custom Audiences (SHA-256 of the normalised email / phone)
async function audienceFile(user, id) {
  if (!S.can(user, 'export')) return S.fail(403, 'Your CRM rights do not allow downloading. Ask a Sales manager.');
  const g = await segmentRows(user, id);
  if (g.error) return g.error;
  const CMP = require('../campaigns'); // eslint-disable-line global-require
  const lines = ['email_sha256,phone_sha256'];
  let n = 0;
  for (const r of g.rows) {
    const e = C.lower(r.email); const p = S.phone10(r.phone);
    if (e && await CMP.optedOut('email', e)) continue; // eslint-disable-line no-await-in-loop, no-continue
    if (!e && p.length !== 10) continue; // eslint-disable-line no-continue
    lines.push(`${e ? C.sha(e) : ''},${p.length === 10 ? C.sha(`+91${p}`) : ''}`); n += 1;
  }
  await S.audit(user, 'CRM ad audience downloaded', 'CrmMktSegment', g.segment.id, `${g.segment.name}: ${n} people (hashed)`);
  return { status: 200, csv: `${lines.join('\n')}\n`, name: `audience-${String(g.segment.name).replace(/[^\w-]+/g, '-').slice(0, 40)}.csv`, rows: n };
}

// ================================================================== 13.03 landing pages and web forms
const SLUG = /^[a-z0-9][a-z0-9-]{1,60}$/;
const FORM_FIELDS = { name: 'Your name', company: 'Company', phone: 'Phone', email: 'Email', city: 'City', message: 'Message' };
async function landings() { return S.okBody({ pages: await B.all('SELECT * FROM "CrmLanding" ORDER BY "updatedAt" DESC LIMIT 200'), fields: FORM_FIELDS, base: `${C.baseUrl()}/api/crm-public/b/p/` }); }
async function saveLanding(user, id, body = {}) {
  const no = C.needManager(user); if (no) return no;
  const title = clip(body.title, 150);
  if (!title) return S.fail(400, 'Give the page a title.');
  let slug = clip(body.slug, 61) ? String(body.slug).toLowerCase().trim().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') : title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  if (!SLUG.test(slug)) return S.fail(400, 'The web address may have small letters, numbers and dashes only.');
  const fields = (Array.isArray(body.fields) ? body.fields : ['name', 'company', 'phone', 'email', 'message']).filter((f) => FORM_FIELDS[f]);
  if (!fields.includes('phone') && !fields.includes('email')) return S.fail(400, 'The form needs the phone or the email field, or nobody can be reached.');
  const data = { slug, kind: body.kind === 'form' ? 'form' : 'page', title, headline: clip(body.headline, 200), body: clip(body.body, 6000), button: clip(body.button, 40) || 'Send', fieldsJson: JSON.stringify(fields), thanks: clip(body.thanks, 400) || 'Thank you. We will be in touch shortly.', campaign: clip(body.campaign, 120) || slug, color: /^#[0-9a-f]{6}$/i.test(body.color || '') ? body.color : '#2563eb', status: body.status === 'Live' ? 'Live' : 'Draft' };
  const clash = await B.one('SELECT "id" FROM "CrmLanding" WHERE "slug" = ? AND "id" != ?', slug, String(id || ''));
  if (clash) { if (body.slug) return S.fail(409, 'Another page already uses this web address.'); slug = `${slug}-${C.token(3).toLowerCase().replace(/[^a-z0-9]/g, '')}`; data.slug = slug; }
  const now = B.nowIso();
  if (id) {
    const old = await B.one('SELECT * FROM "CrmLanding" WHERE "id" = ?', String(id).slice(0, 60));
    if (!old) return S.fail(404, 'This page is not there.');
    const keys = Object.keys(data);
    await B.run(`UPDATE "CrmLanding" SET ${keys.map((k) => `"${k}" = ?`).join(', ')}, "updatedAt" = ? WHERE "id" = ?`, ...keys.map((k) => data[k]), now, old.id);
    return S.okBody({ ok: true, id: old.id, slug: data.slug });
  }
  const lid = C.newId('lp');
  const keys = Object.keys(data);
  await B.run(`INSERT INTO "CrmLanding" ("id", ${keys.map((k) => `"${k}"`).join(', ')}, "byId", "byName", "createdAt", "updatedAt") VALUES (?, ${keys.map(() => '?').join(', ')}, ?, ?, ?, ?)`, lid, ...keys.map((k) => data[k]), user.id, user.name || null, now, now);
  return S.okBody({ ok: true, id: lid, slug: data.slug });
}
async function removeLanding(user, id) {
  const no = C.needManager(user); if (no) return no;
  await B.run('DELETE FROM "CrmLanding" WHERE "id" = ?', String(id || '').slice(0, 60));
  return S.okBody({ ok: true });
}
function landingHtml(lp, { embed, sent, error, utm = {} } = {}) {
  const fields = json(lp.fieldsJson, []);
  const paras = String(lp.body || '').split(/\n{2,}/).filter(Boolean).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
  const hidden = Object.entries(utm).filter(([, v]) => v).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
  const form = sent ? `<p style="color:#15803d;font-weight:600">${esc(lp.thanks)}</p>` : `<form method="post">${error ? `<p style="color:#b91c1c">${esc(error)}</p>` : ''}${fields.map((f) => (f === 'message'
    ? `<label for="f-${f}">${FORM_FIELDS[f]}</label><textarea id="f-${f}" name="${f}" rows="4"></textarea>`
    : `<label for="f-${f}">${FORM_FIELDS[f]}</label><input id="f-${f}" name="${f}" ${f === 'email' ? 'type="email"' : (f === 'phone' ? 'type="tel"' : '')} ${f === 'name' ? 'required' : ''}>`)).join('')}
    <input name="website_url" style="display:none" tabindex="-1" autocomplete="off">${hidden}<input type="hidden" name="vid" id="tl-vid"><button style="background:${esc(lp.color)}">${esc(lp.button)}</button></form>
    <script>try{document.getElementById('tl-vid').value=localStorage.getItem('tl_vid')||''}catch(e){}</script>`;
  const inner = `${embed ? '' : `<h1>${esc(lp.headline || lp.title)}</h1>${paras}`}${form}<p class="muted" style="margin-top:14px">Your details are used only to answer you. We do not share them.</p>`;
  return C.page(lp.title, inner, { wide: !embed });
}
async function landingView(slug) {
  const lp = await B.one('SELECT * FROM "CrmLanding" WHERE "slug" = ? AND "status" = \'Live\'', String(slug || '').slice(0, 61));
  if (lp) await B.run('UPDATE "CrmLanding" SET "views" = "views" + 1 WHERE "id" = ?', lp.id);
  return lp;
}
async function landingSubmit(slug, body = {}) {
  const lp = await B.one('SELECT * FROM "CrmLanding" WHERE "slug" = ? AND "status" = \'Live\'', String(slug || '').slice(0, 61));
  if (!lp) return { error: 'This page is not available.', status: 404 };
  if (clip(body.website_url, 100)) return { lp, ok: true }; // the robot trap
  const l = await C.makeLead({
    company: clip(body.company, 200) || clip(body.name, 200), name: clip(body.name, 200), phone: clip(body.phone, 40), email: clip(body.email, 200),
    source: 'Website', notes: [clip(body.message, 1500), body.city ? `City: ${clip(body.city, 60)}` : ''].filter(Boolean).join('\n') || `Filled the page "${lp.title}"`,
    utm: { utmSource: clip(body.utm_source, 120) || 'landing-page', utmMedium: clip(body.utm_medium, 120), utmCampaign: clip(body.utm_campaign, 120) || lp.campaign, pageUrl: `${C.baseUrl()}/api/crm-public/b/p/${lp.slug}` },
    visitorId: clip(body.vid, 60), byName: `Landing page "${lp.title}"`,
  });
  if (l.error) return { lp, error: l.error, status: 400 };
  await B.run('UPDATE "CrmLanding" SET "submits" = "submits" + 1 WHERE "id" = ?', lp.id);
  if (body.city && l.lead && !l.duplicate) await B.run('UPDATE "CrmLead" SET "city" = COALESCE("city", ?) WHERE "id" = ?', clip(body.city, 60), l.lead.id);
  return { lp, ok: true, leadId: l.lead && l.lead.id, duplicate: l.duplicate };
}

// ================================================================== 13.04 campaign ROI
async function setCampaignMeta(user, id, body = {}) {
  const no = C.needManager(user); if (no) return no;
  const c = await B.one('SELECT * FROM "CrmCampaign" WHERE "id" = ?', String(id || '').slice(0, 60));
  if (!c) return S.fail(404, 'This campaign is not there.');
  const cost = body.cost === '' || body.cost == null ? null : Number(String(body.cost).replace(/[, ]/g, ''));
  if (cost != null && !(cost >= 0)) return S.fail(400, 'Write the cost as a number.');
  const code = clip(body.code, 60) ? String(body.code).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-') : null;
  const st = await B.settings();
  const topic = clip(body.topic, 60) && st.topics.includes(body.topic) ? body.topic : null;
  await B.run('UPDATE "CrmCampaign" SET "cost" = ?, "code" = ?, "topic" = ? WHERE "id" = ?', cost, code, topic, c.id);
  return S.okBody({ ok: true });
}
async function roi(user) {
  const camps = await B.all('SELECT * FROM "CrmCampaign" ORDER BY "createdAt" DESC LIMIT 100');
  const out = [];
  for (const c of camps) {
    /* eslint-disable no-await-in-loop */
    const tr = await B.one('SELECT COUNT(*) AS "tracked", SUM(CASE WHEN "openCount" > 0 THEN 1 ELSE 0 END) AS "opened", SUM(CASE WHEN "clickCount" > 0 THEN 1 ELSE 0 END) AS "clicked" FROM "CrmMailTrack" WHERE "campaignId" = ?', c.id);
    const keys = [c.id, c.code, c.name].filter(Boolean);
    const brought = await B.all(`SELECT l."id", l."dealId" FROM "CrmLead" l WHERE l."campaignId" = ? OR l."utmCampaign" IN (${keys.map(() => '?').join(',')})`, c.id, ...keys);
    const reached = await B.all('SELECT r."recordId" AS "id", l."dealId" FROM "CrmCampaignRecipient" r JOIN "CrmLead" l ON l."id" = r."recordId" WHERE r."campaignId" = ? AND r."status" = \'sent\' AND r."kind" = \'lead\'', c.id);
    const dealIds = [...new Set([...brought, ...reached].map((x) => x.dealId).filter(Boolean))];
    const won = dealIds.length ? await B.all(`SELECT "id", "value", "finalValue", "wonAt" FROM "CrmDeal" WHERE "stage" = 'Won' AND "id" IN (${dealIds.map(() => '?').join(',')}) AND COALESCE("wonAt", "updatedAt") >= ?`, ...dealIds, c.startedAt || c.createdAt) : [];
    const value = won.reduce((s, d) => s + (Number(d.finalValue != null ? d.finalValue : d.value) || 0), 0);
    const cost = c.cost == null ? null : Number(c.cost);
    out.push({
      id: c.id, name: c.name, channel: c.channel, status: c.status, code: c.code || null, topic: c.topic || null, cost, sent: Number(c.sent) || 0,
      opened: Number(tr.opened) || 0, clicked: Number(tr.clicked) || 0, tracked: Number(tr.tracked) || 0,
      leads: brought.length, reachedLeads: reached.length, wonDeals: won.length, wonValue: value, roiPercent: cost ? Math.round(((value - cost) / cost) * 100) : null,
    });
    /* eslint-enable no-await-in-loop */
  }
  return S.okBody({ campaigns: out, canEdit: C.isManager(user), topics: (await B.settings()).topics });
}

// ================================================================== 13.05 social
let fetchImpl = (...a) => fetch(...a);
function setFetch(fn) { fetchImpl = fn || ((...a) => fetch(...a)); }
async function socialAccounts() {
  const SA = require('../../utils/socialAccounts'); // eslint-disable-line global-require
  const all = await SA.readAll().catch(() => []);
  const fb = all.find((a) => a.platform === 'facebook' && a.isDefault && a.status !== 'Removed') || all.find((a) => a.platform === 'facebook' && a.status !== 'Removed');
  const li = await SA.defaultLinkedin().catch(() => null);
  return { facebook: fb ? { name: fb.name, id: fb.externalId, tokenEnc: fb.tokenEnc } : null, linkedin: li };
}
async function socialPosts(user) {
  const acc = await socialAccounts();
  return S.okBody({ posts: await B.all('SELECT * FROM "CrmSocialPost" ORDER BY COALESCE("postedAt", "postAt", "createdAt") DESC LIMIT 100'), accounts: { facebook: acc.facebook ? acc.facebook.name : null, linkedin: acc.linkedin ? (acc.linkedin.page ? acc.linkedin.page.name : acc.linkedin.name) : null }, on: await B.on('socialPosting'), canPost: C.isManager(user) });
}
async function saveSocialPost(user, id, body = {}) {
  const no = C.needManager(user); if (no) return no;
  const channel = ['facebook', 'linkedin'].includes(body.channel) ? body.channel : null;
  if (!channel) return S.fail(400, 'Pick Facebook or LinkedIn.');
  const text = clip(body.text, 3000);
  if (!text) return S.fail(400, 'Write the post.');
  const link = clip(body.link, 500);
  if (link && !/^https?:\/\//i.test(link)) return S.fail(400, 'The link must start with http:// or https://');
  let postAt = null;
  if (body.postAt) { const t = new Date(body.postAt); if (Number.isNaN(t.getTime()) || t.getTime() < Date.now()) return S.fail(400, 'Pick a time in the future.'); postAt = t.toISOString(); }
  const now = B.nowIso();
  if (id) {
    const p = await B.one('SELECT * FROM "CrmSocialPost" WHERE "id" = ?', String(id).slice(0, 60));
    if (!p || p.status === 'Posted') return S.fail(400, 'A posted post cannot be changed.');
    await B.run('UPDATE "CrmSocialPost" SET "channel" = ?, "text" = ?, "link" = ?, "postAt" = ?, "status" = ?, "updatedAt" = ? WHERE "id" = ?', channel, text, link, postAt, postAt ? 'Scheduled' : 'Draft', now, p.id);
    return S.okBody({ ok: true, id: p.id });
  }
  const pid = C.newId('sp');
  await B.run('INSERT INTO "CrmSocialPost" ("id","channel","text","link","status","postAt","byId","byName","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?)', pid, channel, text, link, postAt ? 'Scheduled' : 'Draft', postAt, user.id, user.name || null, now, now);
  return S.okBody({ ok: true, id: pid });
}
async function publishPost(p) {
  const acc = await socialAccounts();
  const { decryptSecret } = require('../../utils/secrets'); // eslint-disable-line global-require
  if (C.sandbox() && !process.env.CRM_B_SOCIAL_LIVE) return { ok: true, ref: `sandbox-${Date.now()}`, sandbox: true };
  if (p.channel === 'facebook') {
    if (!acc.facebook) return { ok: false, error: 'No Facebook Page is connected (Administration > Integrations > Social Media).' };
    const token = acc.facebook.tokenEnc ? decryptSecret(acc.facebook.tokenEnc) : null;
    if (!token) return { ok: false, error: 'The Facebook Page token is missing: connect the Page again.' };
    const r = await fetchImpl(`https://graph.facebook.com/v19.0/${encodeURIComponent(acc.facebook.id)}/feed`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ message: p.text, ...(p.link ? { link: p.link } : {}), access_token: token }).toString() });
    const j = await r.json().catch(() => ({}));
    return r.ok && j.id ? { ok: true, ref: j.id } : { ok: false, error: (j.error && j.error.message) || `Facebook said ${r.status}` };
  }
  if (!acc.linkedin) return { ok: false, error: 'No LinkedIn account is connected (Administration > Integrations > Social Media).' };
  if (acc.linkedin.expired) return { ok: false, error: 'The LinkedIn connection has expired: connect it again.' };
  let author = acc.linkedin.page ? acc.linkedin.page.urn : null;
  if (!author) { const me = await fetchImpl('https://api.linkedin.com/v2/userinfo', { headers: { Authorization: `Bearer ${acc.linkedin.token}` } }).then((r) => r.json()).catch(() => ({})); author = me.sub ? `urn:li:person:${me.sub}` : null; }
  if (!author) return { ok: false, error: 'LinkedIn did not say who is posting.' };
  const r = await fetchImpl('https://api.linkedin.com/v2/ugcPosts', { method: 'POST', headers: { Authorization: `Bearer ${acc.linkedin.token}`, 'Content-Type': 'application/json', 'X-Restli-Protocol-Version': '2.0.0' }, body: JSON.stringify({ author, lifecycleState: 'PUBLISHED', specificContent: { 'com.linkedin.ugc.ShareContent': { shareCommentary: { text: p.link ? `${p.text}\n${p.link}` : p.text }, shareMediaCategory: 'NONE' } }, visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' } }) });
  const id = r.headers && r.headers.get ? r.headers.get('x-restli-id') : null;
  const j = await r.json().catch(() => ({}));
  return r.ok ? { ok: true, ref: id || j.id || 'posted' } : { ok: false, error: j.message || `LinkedIn said ${r.status}` };
}
async function postNow(user, id) {
  const no = C.needManager(user); if (no) return no;
  const p = await B.one('SELECT * FROM "CrmSocialPost" WHERE "id" = ?', String(id || '').slice(0, 60));
  if (!p) return S.fail(404, 'This post is not there.');
  if (p.status === 'Posted') return S.fail(400, 'This is posted already.');
  const r = await publishPost(p);
  await B.run('UPDATE "CrmSocialPost" SET "status" = ?, "ref" = ?, "error" = ?, "postedAt" = ?, "updatedAt" = ? WHERE "id" = ?', r.ok ? 'Posted' : 'Failed', r.ref || null, r.ok ? null : clip(r.error, 300), r.ok ? B.nowIso() : null, B.nowIso(), p.id);
  await S.audit(user, 'CRM social post', 'CrmSocialPost', p.id, `${p.channel}: ${r.ok ? 'posted' : r.error}`);
  return r.ok ? S.okBody({ ok: true, ref: r.ref, sandbox: !!r.sandbox }) : S.fail(502, `It was not posted: ${r.error}`);
}
async function runSocial() {
  if (!(await B.on('socialPosting'))) return { off: true };
  const due = await B.all('SELECT * FROM "CrmSocialPost" WHERE "status" = \'Scheduled\' AND "postAt" <= ? LIMIT 5', B.nowIso());
  let n = 0;
  for (const p of due) {
    const r = await publishPost(p); // eslint-disable-line no-await-in-loop
    await B.run('UPDATE "CrmSocialPost" SET "status" = ?, "ref" = ?, "error" = ?, "postedAt" = ? WHERE "id" = ?', r.ok ? 'Posted' : 'Failed', r.ref || null, r.ok ? null : clip(r.error, 300), r.ok ? B.nowIso() : null, p.id); // eslint-disable-line no-await-in-loop
    n += 1;
  }
  return { posted: n };
}
async function saveSocialLinks(user, leadId, body = {}) {
  const row = await C.editable(user, 'lead', leadId);
  if (!row) return S.fail(404, 'This lead is not there, or it is not yours.');
  const ok = (v) => { const s = clip(v, 300); return s && /^https?:\/\//i.test(s) ? s : null; };
  await B.run('UPDATE "CrmLead" SET "linkedinUrl" = ?, "twitterUrl" = ?, "facebookUrl" = ?, "updatedAt" = ? WHERE "id" = ?', ok(body.linkedinUrl), ok(body.twitterUrl), ok(body.facebookUrl), B.nowIso(), row.id);
  return S.okBody({ ok: true });
}

// ================================================================== 13.06 website visits
async function trackView(body = {}) {
  const st = await B.settings();
  if (!st.siteId || body.k !== st.siteId || !st.webTracking) return { stored: false };
  const v = clip(body.v, 60);
  if (!v || !/^[a-z0-9]{6,60}$/i.test(v)) return { stored: false };
  const recent = await B.one('SELECT COUNT(*) AS "n" FROM "CrmWebVisit" WHERE "visitorId" = ? AND "at" >= ?', v, new Date(Date.now() - 60000).toISOString());
  if (Number(recent.n) > 30) return { stored: false };
  const lead = await B.one('SELECT "id" FROM "CrmLead" WHERE "visitorId" = ? LIMIT 1', v);
  let utmSource = null; let utmCampaign = null;
  try { const u = new URL(String(body.url || '')); utmSource = u.searchParams.get('utm_source'); utmCampaign = u.searchParams.get('utm_campaign'); } catch { /* not a URL */ }
  await B.run('INSERT INTO "CrmWebVisit" ("id","visitorId","leadId","url","title","referrer","utmSource","utmCampaign","at") VALUES (?,?,?,?,?,?,?,?,?)', C.newId('wv'), v, lead ? lead.id : null, clip(body.url, 500), clip(body.title, 200), clip(body.ref, 500), clip(utmSource, 120), clip(utmCampaign, 120), B.nowIso());
  return { stored: true };
}
async function identify(body = {}) {
  const st = await B.settings();
  if (!st.siteId || body.k !== st.siteId || !st.webTracking) return { linked: false };
  const v = clip(body.v, 60); const e = C.lower(body.email);
  if (!v || !C.validEmail(e)) return { linked: false };
  const lead = await B.one('SELECT "id" FROM "CrmLead" WHERE LOWER("email") = ? ORDER BY "createdAt" DESC LIMIT 1', e);
  if (!lead) return { linked: false, pending: true };
  await B.run('UPDATE "CrmLead" SET "visitorId" = COALESCE("visitorId", ?) WHERE "id" = ?', v, lead.id);
  await B.run('UPDATE "CrmWebVisit" SET "leadId" = ? WHERE "visitorId" = ? AND "leadId" IS NULL', lead.id, v);
  return { linked: true };
}
async function visitsOf(user, leadId) {
  const row = await C.visible(user, 'lead', leadId);
  if (!row) return S.fail(404, 'This lead is not there, or it is not yours.');
  const rows = await B.all('SELECT "url", "title", "referrer", "utmSource", "utmCampaign", "at" FROM "CrmWebVisit" WHERE "leadId" = ? ORDER BY "at" DESC LIMIT 200', row.id);
  return S.okBody({ on: await B.on('webTracking'), visits: rows, pages: [...new Set(rows.map((r) => r.url))].length });
}
function trackerJs(base, k) {
  return `(function(){if(window.__tlT)return;window.__tlT=1;var B=${JSON.stringify(base)},K=${JSON.stringify(k)},S;try{S=localStorage}catch(e){S={getItem:function(){return null},setItem:function(){}}}
var v=S.getItem('tl_vid');if(!v){v='v'+Math.random().toString(36).slice(2)+Date.now().toString(36);S.setItem('tl_vid',v)}
function send(p,b){try{var x=JSON.stringify(b);if(navigator.sendBeacon){navigator.sendBeacon(B+p,new Blob([x],{type:'text/plain'}))}else fetch(B+p,{method:'POST',body:x,keepalive:true})}catch(e){}}
send('/api/crm-public/b/w/pv',{k:K,v:v,url:location.href,title:document.title,ref:document.referrer});
document.addEventListener('submit',function(e){try{var f=e.target,m=f.querySelector('input[type=email],input[name*=mail]');if(m&&m.value)send('/api/crm-public/b/w/id',{k:K,v:v,email:m.value})}catch(x){}},true)})();`;
}

// ================================================================== 13.07 nurture journeys
const J_CHANNELS = ['email', 'whatsapp', 'sms', 'task'];
function cleanSteps(list) {
  const steps = (Array.isArray(list) ? list : []).slice(0, 12).map((s) => ({ channel: J_CHANNELS.includes(s.channel) ? s.channel : 'email', afterDays: Math.max(0, Math.min(180, Math.round(Number(s.afterDays)) || 0)), subject: clip(s.subject, 200), body: clip(s.body, 4000) }));
  for (const [i, s] of steps.entries()) {
    if (!s.body) return { error: `Write the message of step ${i + 1}.` };
    if (s.channel === 'email' && !s.subject) return { error: `Write the subject of step ${i + 1}.` };
  }
  if (!steps.length) return { error: 'Add at least one step.' };
  return { steps };
}
async function journeys() {
  const rows = await B.all('SELECT j.*, (SELECT COUNT(*) FROM "CrmJourneyRun" r WHERE r."journeyId" = j."id" AND r."status" = \'Running\') AS "running", (SELECT COUNT(*) FROM "CrmJourneyRun" r WHERE r."journeyId" = j."id" AND r."status" = \'Done\') AS "finished", (SELECT COUNT(*) FROM "CrmJourneyRun" r WHERE r."journeyId" = j."id" AND r."status" = \'Stopped\') AS "stopped" FROM "CrmJourney" j ORDER BY j."createdAt" DESC');
  return S.okBody({ journeys: rows.map((j) => ({ ...j, steps: json(j.stepsJson, []), on: !!j.on })), switchOn: await B.on('journeys') });
}
async function saveJourney(user, id, body = {}) {
  const no = C.needManager(user); if (no) return no;
  const name = clip(body.name, 120);
  if (!name) return S.fail(400, 'Give the journey a name.');
  const trigger = ['new_lead', 'segment'].includes(body.trigger) ? body.trigger : 'new_lead';
  if (trigger === 'segment' && !(await B.one('SELECT "id" FROM "CrmMktSegment" WHERE "id" = ?', String(body.segmentId || '')))) return S.fail(400, 'Pick the segment whose people go on this journey.');
  const c = cleanSteps(body.steps);
  if (c.error) return S.fail(400, c.error);
  const now = B.nowIso();
  if (id) {
    const j = await B.one('SELECT * FROM "CrmJourney" WHERE "id" = ?', String(id).slice(0, 60));
    if (!j) return S.fail(404, 'This journey is not there.');
    await B.run('UPDATE "CrmJourney" SET "name" = ?, "trigger" = ?, "segmentId" = ?, "source" = ?, "stepsJson" = ?, "updatedAt" = ? WHERE "id" = ?', name, trigger, trigger === 'segment' ? body.segmentId : null, clip(body.source, 60), JSON.stringify(c.steps), now, j.id);
    return S.okBody({ ok: true, id: j.id });
  }
  const jid = C.newId('jr');
  await B.run('INSERT INTO "CrmJourney" ("id","name","trigger","segmentId","source","stepsJson","on","byId","byName","createdAt","updatedAt") VALUES (?,?,?,?,?,?,0,?,?,?,?)', jid, name, trigger, trigger === 'segment' ? body.segmentId : null, clip(body.source, 60), JSON.stringify(c.steps), user.id, user.name || null, now, now);
  return S.okBody({ ok: true, id: jid });
}
async function setJourneyOn(user, id, onFlag) {
  const no = C.needManager(user); if (no) return no;
  const j = await B.one('SELECT * FROM "CrmJourney" WHERE "id" = ?', String(id || '').slice(0, 60));
  if (!j) return S.fail(404, 'This journey is not there.');
  await B.run('UPDATE "CrmJourney" SET "on" = ?, "armedAt" = CASE WHEN ? = 1 THEN COALESCE("armedAt", ?) ELSE "armedAt" END, "updatedAt" = ? WHERE "id" = ?', onFlag ? 1 : 0, onFlag ? 1 : 0, B.nowIso(), B.nowIso(), j.id);
  if (!onFlag) await B.run('UPDATE "CrmJourneyRun" SET "status" = \'Paused\' WHERE "journeyId" = ? AND "status" = \'Running\'', j.id);
  else await B.run('UPDATE "CrmJourneyRun" SET "status" = \'Running\' WHERE "journeyId" = ? AND "status" = \'Paused\'', j.id);
  await S.audit(user, onFlag ? 'CRM journey switched on' : 'CRM journey switched off', 'CrmJourney', j.id, j.name);
  return S.okBody({ ok: true, switchOn: await B.on('journeys') });
}
async function removeJourney(user, id) {
  const no = C.needManager(user); if (no) return no;
  await B.run('DELETE FROM "CrmJourneyRun" WHERE "journeyId" = ?', String(id || ''));
  await B.run('DELETE FROM "CrmJourney" WHERE "id" = ?', String(id || ''));
  return S.okBody({ ok: true });
}
async function stopReason(kind, rec) {
  if (!rec) return 'the record is gone';
  if (kind === 'lead') {
    if (['Converted', 'Junk'].includes(rec.status)) return `the lead is ${String(rec.status).toLowerCase()}`;
    if (Number(rec.autoPaused) === 1) return 'they replied (or somebody pressed Stop)';
    if (['Won', 'Lost'].includes(rec.stage)) return `the lead is ${String(rec.stage).toLowerCase()}`;
  }
  return null;
}
async function journeyStep(j, run, rec, step) {
  const CMP = require('../campaigns'); // eslint-disable-line global-require
  const messaging = require('../../utils/messaging'); // eslint-disable-line global-require
  const x = { name: run.kind === 'lead' ? rec.contactName : rec.name, company: rec.company || '', city: rec.city || '' };
  const text = CMP.merge(step.body, x, rec.ownerName || 'TeamLink');
  const links = C.linksFor(run.kind, rec);
  if (step.channel === 'task') {
    if (!rec.ownerId) return { ok: true, note: 'no owner, no follow-up' };
    const now = B.nowIso();
    await S.insert('CrmTask', { id: S.newId('task'), title: clip(`${j.name}: ${text}`, 200), dueDate: S.istToday(), status: 'Open', type: 'Call', priority: 'Medium', leadId: links.leadId || null, accountId: links.accountId || null, ownerId: rec.ownerId, ownerName: rec.ownerName, createdAt: now, updatedAt: now, origin: 'journey' });
    return { ok: true, note: 'follow-up made' };
  }
  if (step.channel === 'email') {
    const to = C.lower(rec.email);
    if (!C.validEmail(to)) return { ok: false, skip: true, note: 'no email' };
    if (await CMP.optedOut('email', to)) return { ok: false, stop: true, note: 'opted out' };
    const subject = CMP.merge(step.subject, x, rec.ownerName || 'TeamLink');
    const r = await messaging.send('Email', { to, subject, text: text + CMP.unsubscribeLine(to), meta: { audience: 'crm', personName: x.name, purpose: `CRM journey: ${j.name}`, source: 'crm-journey' } });
    if (!r.ok) return { ok: false, note: r.error || 'not sent' };
    await C.systemActivity(links, { kind: 'email', subject: `Journey "${j.name}": ${subject}`, note: `To ${to}\n\n${text}`, byName: 'Journey' });
    return { ok: true };
  }
  const m = require('../../utils/messagingCore').normalizeMobile(rec.phone); // eslint-disable-line global-require
  if (!m.ok) return { ok: false, skip: true, note: 'no mobile number' };
  if (await CMP.optedOut('whatsapp', m.e164) || await CMP.optedOut('sms', m.e164)) return { ok: false, stop: true, note: 'opted out' };
  const r = await messaging.send(step.channel === 'sms' ? 'SMS' : 'WhatsApp', { to: m.e164, kind: 'bulk', text, vars: [text], meta: { audience: 'crm', personName: x.name, purpose: `CRM journey: ${j.name}`, source: 'crm-journey' } });
  if (!r.ok) return { ok: false, note: r.error || 'not sent' };
  await C.systemActivity(links, { kind: step.channel === 'sms' ? 'note' : 'whatsapp', subject: `Journey "${j.name}" (${step.channel === 'sms' ? 'SMS' : 'WhatsApp'})`, note: `To +${m.e164}\n\n${text}`, byName: 'Journey' });
  return { ok: true };
}
async function runJourneys({ now = Date.now() } = {}) {
  if (!(await B.on('journeys'))) return { off: true };
  const out = { enrolled: 0, sent: 0, stopped: 0, failed: 0 };
  const live = await B.all('SELECT * FROM "CrmJourney" WHERE "on" = 1');
  const nowIso = new Date(now).toISOString();
  for (const j of live) {
    /* eslint-disable no-await-in-loop */
    const steps = json(j.stepsJson, []);
    if (!steps.length) continue; // eslint-disable-line no-continue
    let people = [];
    if (j.trigger === 'new_lead') {
      people = (await B.all(`SELECT 'lead' AS "kind", "id" FROM "CrmLead" WHERE "createdAt" >= ? AND "status" IN ('New', 'Contacted')${j.source ? ' AND "source" = ?' : ''} AND "company" NOT LIKE 'Sample%' LIMIT 200`, j.armedAt || nowIso, ...(j.source ? [j.source] : [])));
    } else {
      const seg = await B.one('SELECT * FROM "CrmMktSegment" WHERE "id" = ?', j.segmentId);
      if (seg) people = (await segmentQuery({ id: j.byId, role: 'SUPER_ADMIN' }, seg.audience, json(seg.filtersJson, {}))).slice(0, 500).map((p) => ({ kind: p.kind, id: p.id }));
    }
    for (const p of people) {
      const first = new Date(now + steps[0].afterDays * 86400000).toISOString();
      const ins = await B.run('INSERT OR IGNORE INTO "CrmJourneyRun" ("id","journeyId","kind","recordId","step","nextAt","status","createdAt","updatedAt") VALUES (?,?,?,?,0,?,\'Running\',?,?)', C.newId('jrun'), j.id, p.kind, p.id, first, nowIso, nowIso);
      if (Number(ins) === 1) out.enrolled += 1;
    }
    if (out.enrolled) await B.run('UPDATE "CrmJourney" SET "enrolled" = (SELECT COUNT(*) FROM "CrmJourneyRun" WHERE "journeyId" = ?) WHERE "id" = ?', j.id, j.id);
    const due = await B.all('SELECT * FROM "CrmJourneyRun" WHERE "journeyId" = ? AND "status" = \'Running\' AND "nextAt" <= ? ORDER BY "nextAt" LIMIT 20', j.id, nowIso);
    for (const run of due) {
      const claimed = await B.run('UPDATE "CrmJourneyRun" SET "status" = \'Sending\' WHERE "id" = ? AND "status" = \'Running\'', run.id);
      if (Number(claimed) !== 1) continue; // eslint-disable-line no-continue
      const rec = await S.getRow(run.kind, run.recordId);
      const why = await stopReason(run.kind, rec);
      const log = json(run.log, []);
      if (why) { await B.run('UPDATE "CrmJourneyRun" SET "status" = \'Stopped\', "log" = ?, "updatedAt" = ? WHERE "id" = ?', JSON.stringify([...log, { at: nowIso, note: `stopped: ${why}` }]).slice(0, 4000), nowIso, run.id); out.stopped += 1; continue; } // eslint-disable-line no-continue
      const step = steps[run.step];
      let r;
      try { r = await journeyStep(j, run, rec, step); } catch (e) { r = { ok: false, note: e.message }; }
      const nextIdx = run.step + 1;
      const doneAll = nextIdx >= steps.length;
      const status = r.stop ? 'Stopped' : (doneAll ? 'Done' : 'Running');
      const nextAt = doneAll ? null : new Date(now + steps[nextIdx].afterDays * 86400000).toISOString();
      await B.run('UPDATE "CrmJourneyRun" SET "status" = ?, "step" = ?, "nextAt" = ?, "log" = ?, "updatedAt" = ? WHERE "id" = ?', status, r.stop ? run.step : nextIdx, nextAt, JSON.stringify([...log, { at: nowIso, step: run.step + 1, channel: step.channel, ok: !!r.ok, note: r.note || null }]).slice(0, 4000), nowIso, run.id);
      if (r.ok) out.sent += 1; else if (r.stop) out.stopped += 1; else out.failed += 1;
    }
    /* eslint-enable no-await-in-loop */
  }
  return out;
}
async function journeyRuns(user, id) {
  const rows = await B.all('SELECT r.*, l."company", l."contactName" FROM "CrmJourneyRun" r LEFT JOIN "CrmLead" l ON l."id" = r."recordId" WHERE r."journeyId" = ? ORDER BY r."updatedAt" DESC LIMIT 300', String(id || '').slice(0, 60));
  return S.okBody({ runs: rows.map((r) => ({ ...r, log: json(r.log, []) })) });
}

// ================================================================== 13.08 ad leads
async function adsConfig() {
  const { readConfig } = require('../../utils/integrationStore'); // eslint-disable-line global-require
  const v = ((await readConfig('crm-ads').catch(() => ({ values: {} }))).values) || {};
  return { pageToken: String(v['Facebook Page access token'] || '').trim(), appSecret: String(v['Facebook App secret'] || '').trim(), verifyToken: String(v['Webhook verify token (any text)'] || '').trim(), googleKey: String(v['Google Ads webhook key (any text)'] || '').trim() };
}
function metaSignatureOk(rawBody, sigHeader, appSecret) {
  if (!appSecret) return true; // no app secret typed yet: the verify token and the Graph lookup still guard it
  const crypto = require('crypto'); // eslint-disable-line global-require
  const want = `sha256=${crypto.createHmac('sha256', appSecret).update(rawBody || '').digest('hex')}`;
  const got = String(sigHeader || '');
  return want.length === got.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(got));
}
const fieldOf = (data, names) => { const f = (data || []).find((x) => names.includes(String(x.name || '').toLowerCase())); return f && Array.isArray(f.values) ? f.values[0] : (f && f.value) || ''; };
async function metaLeads(payload) {
  if (!(await B.on('adsLeads'))) return { off: true };
  const cfg = await adsConfig();
  const out = { made: 0, duplicate: 0, errors: [] };
  for (const e of (payload && payload.entry) || []) {
    for (const ch of e.changes || []) {
      const v = ch.value || {};
      if (!v.leadgen_id) continue; // eslint-disable-line no-continue
      /* eslint-disable no-await-in-loop */
      let data = v.field_data || null;
      if (!data) {
        if (!cfg.pageToken) { out.errors.push('No Facebook Page access token (Administration > Integrations > CRM ad leads).'); continue; } // eslint-disable-line no-continue
        const j = await fetchImpl(`https://graph.facebook.com/v19.0/${encodeURIComponent(v.leadgen_id)}?access_token=${encodeURIComponent(cfg.pageToken)}`).then((r) => r.json()).catch((err) => ({ error: { message: err.message } }));
        if (j.error) { out.errors.push(j.error.message); continue; } // eslint-disable-line no-continue
        data = j.field_data || [];
      }
      const l = await C.makeLead({
        company: fieldOf(data, ['company_name', 'company']) || fieldOf(data, ['full_name', 'name']), name: fieldOf(data, ['full_name', 'name']), phone: fieldOf(data, ['phone_number', 'phone']), email: fieldOf(data, ['email']),
        source: 'Other', notes: `Facebook / Instagram lead ad (form ${v.form_id || '-'})`, utm: { utmSource: 'facebook-ads', utmMedium: 'lead-ad', utmCampaign: v.ad_id || v.form_id || null }, byName: 'Facebook lead ad',
      });
      if (l.error) out.errors.push(l.error); else if (l.duplicate) out.duplicate += 1; else out.made += 1;
      /* eslint-enable no-await-in-loop */
    }
  }
  return out;
}
async function googleLead(body = {}) {
  if (!(await B.on('adsLeads'))) return { status: 200, body: { off: true } };
  const cfg = await adsConfig();
  if (!cfg.googleKey || String(body.google_key || '') !== cfg.googleKey) return { status: 401, body: { error: 'The key is not right.' } };
  const col = (id) => { const c = (body.user_column_data || []).find((x) => x.column_id === id); return c ? c.string_value : ''; };
  if (body.is_test) return { status: 200, body: { ok: true, test: true } };
  const l = await C.makeLead({
    company: col('COMPANY_NAME') || col('FULL_NAME') || [col('FIRST_NAME'), col('LAST_NAME')].filter(Boolean).join(' '), name: col('FULL_NAME') || [col('FIRST_NAME'), col('LAST_NAME')].filter(Boolean).join(' '), phone: col('PHONE_NUMBER'), email: col('EMAIL'),
    source: 'Other', notes: `Google Ads lead form (campaign ${body.campaign_id || '-'})`, utm: { utmSource: 'google-ads', utmMedium: 'lead-form', utmCampaign: String(body.campaign_id || '') || null }, byName: 'Google Ads lead form',
  });
  if (l.error) return { status: 400, body: { error: l.error } };
  return { status: 200, body: { ok: true, duplicate: l.duplicate } };
}

// ================================================================== 13.09 events and webinars
async function events() {
  return S.okBody({ events: await B.all('SELECT e.*, (SELECT COUNT(*) FROM "CrmMktEventReg" r WHERE r."eventId" = e."id") AS "registered", (SELECT COUNT(*) FROM "CrmMktEventReg" r WHERE r."eventId" = e."id" AND r."status" = \'Attended\') AS "attended" FROM "CrmMktEvent" e ORDER BY e."startsAt" DESC LIMIT 100'), base: `${C.baseUrl()}/api/crm-public/b/e/` });
}
async function saveEvent(user, id, body = {}) {
  const no = C.needManager(user); if (no) return no;
  const title = clip(body.title, 150);
  if (!title) return S.fail(400, 'Give the event a name.');
  const start = new Date(body.startsAt || '');
  if (Number.isNaN(start.getTime())) return S.fail(400, 'Pick when it starts.');
  const end = body.endsAt ? new Date(body.endsAt) : null;
  if (end && (Number.isNaN(end.getTime()) || end < start)) return S.fail(400, 'It must end after it starts.');
  const link = clip(body.link, 500);
  if (link && !/^https?:\/\//i.test(link)) return S.fail(400, 'The meeting link must start with https://');
  const data = { title, kind: ['Webinar', 'Event', 'Workshop', 'Meetup'].includes(body.kind) ? body.kind : 'Webinar', startsAt: start.toISOString(), endsAt: end ? end.toISOString() : null, place: clip(body.place, 200), link, capacity: Math.max(0, Math.round(Number(body.capacity)) || 0) || null, description: clip(body.description, 4000), status: body.status === 'Closed' ? 'Closed' : 'Open' };
  const now = B.nowIso();
  if (id) {
    const ev = await B.one('SELECT * FROM "CrmMktEvent" WHERE "id" = ?', String(id).slice(0, 60));
    if (!ev) return S.fail(404, 'This event is not there.');
    const keys = Object.keys(data);
    await B.run(`UPDATE "CrmMktEvent" SET ${keys.map((k) => `"${k}" = ?`).join(', ')}, "updatedAt" = ? WHERE "id" = ?`, ...keys.map((k) => data[k]), now, ev.id);
    return S.okBody({ ok: true, id: ev.id, slug: ev.slug });
  }
  const slug = `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)}-${C.token(3).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
  const eid = C.newId('ev');
  const keys = Object.keys(data);
  await B.run(`INSERT INTO "CrmMktEvent" ("id", "slug", ${keys.map((k) => `"${k}"`).join(', ')}, "byId", "byName", "createdAt", "updatedAt") VALUES (?, ?, ${keys.map(() => '?').join(', ')}, ?, ?, ?, ?)`, eid, slug, ...keys.map((k) => data[k]), user.id, user.name || null, now, now);
  return S.okBody({ ok: true, id: eid, slug });
}
async function eventRegs(user, id) {
  const ev = await B.one('SELECT * FROM "CrmMktEvent" WHERE "id" = ?', String(id || '').slice(0, 60));
  if (!ev) return S.fail(404, 'This event is not there.');
  return S.okBody({ event: ev, registrations: await B.all('SELECT * FROM "CrmMktEventReg" WHERE "eventId" = ? ORDER BY "at" DESC', ev.id) });
}
async function markAttendance(user, regId, { status } = {}) {
  const no = C.needWork(user); if (no) return no;
  const st = ['Registered', 'Attended', 'No-show', 'Cancelled'].includes(status) ? status : null;
  if (!st) return S.fail(400, 'Pick Attended, No-show or Cancelled.');
  const r = await B.one('SELECT r.*, e."title" FROM "CrmMktEventReg" r JOIN "CrmMktEvent" e ON e."id" = r."eventId" WHERE r."id" = ?', String(regId || '').slice(0, 60));
  if (!r) return S.fail(404, 'This registration is not there.');
  await B.run('UPDATE "CrmMktEventReg" SET "status" = ? WHERE "id" = ?', st, r.id);
  if (r.leadId && st !== 'Registered') await C.systemActivity({ leadId: r.leadId }, { kind: 'meeting', subject: `${r.title}: ${st.toLowerCase()}`, byId: user.id, byName: user.name });
  return S.okBody({ ok: true });
}
async function eventOfSlug(slug) { return B.one('SELECT * FROM "CrmMktEvent" WHERE "slug" = ?', String(slug || '').slice(0, 80)); }
async function register(slug, body = {}) {
  const ev = await eventOfSlug(slug);
  if (!ev || ev.status !== 'Open') return { error: 'Registration for this event is closed.', status: 404 };
  if (Date.parse(ev.endsAt || ev.startsAt) < Date.now()) return { ev, error: 'This event is over.', status: 400 };
  if (clip(body.website_url, 100)) return { ev, ok: true };
  const name = clip(body.name, 150); const email = C.validEmail(body.email) ? C.lower(body.email) : null; const phone = clip(body.phone, 40);
  if (!name) return { ev, error: 'Write your name.', status: 400 };
  if (!email && !phone) return { ev, error: 'Write your email or phone so we can send the joining details.', status: 400 };
  if (email && await B.one('SELECT "id" FROM "CrmMktEventReg" WHERE "eventId" = ? AND "email" = ?', ev.id, email)) return { ev, ok: true, already: true };
  if (ev.capacity) { const n = await B.one('SELECT COUNT(*) AS "n" FROM "CrmMktEventReg" WHERE "eventId" = ? AND "status" != \'Cancelled\'', ev.id); if (Number(n.n) >= ev.capacity) return { ev, error: 'Sorry, this event is full.', status: 409 }; }
  const l = await C.makeLead({ company: clip(body.company, 200) || name, name, phone, email, source: 'Event', notes: `Registered for ${ev.kind.toLowerCase()} "${ev.title}"`, utm: { utmSource: 'event', utmCampaign: ev.slug }, byName: `${ev.kind} registration` });
  await B.run('INSERT INTO "CrmMktEventReg" ("id","eventId","name","email","phone","company","leadId","status","at") VALUES (?,?,?,?,?,?,?,\'Registered\',?)', C.newId('reg'), ev.id, name, email, phone, clip(body.company, 200), l.lead ? l.lead.id : null, B.nowIso());
  return { ev, ok: true };
}
function eventHtml(ev, { done, error, already } = {}) {
  const when = new Date(ev.startsAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short' });
  const form = done ? `<p style="color:#15803d;font-weight:600">${already ? 'You are already registered.' : 'You are registered. We will send the joining details before it starts.'}</p>${ev.link ? `<p>Joining link: <a href="${esc(ev.link)}">${esc(ev.link)}</a></p>` : ''}`
    : `<form method="post">${error ? `<p style="color:#b91c1c">${esc(error)}</p>` : ''}<label for="n">Your name</label><input id="n" name="name" required><label for="c">Company</label><input id="c" name="company"><label for="e">Email</label><input id="e" type="email" name="email"><label for="p">Phone</label><input id="p" type="tel" name="phone"><input name="website_url" style="display:none" tabindex="-1" autocomplete="off"><button>Register</button></form>`;
  return C.page(ev.title, `<p class="muted">${esc(ev.kind)}</p><h1>${esc(ev.title)}</h1><p><b>${esc(when)}</b> (India time)${ev.place ? `<br>${esc(ev.place)}` : ''}</p>${String(ev.description || '').split(/\n{2,}/).filter(Boolean).map((x) => `<p>${esc(x)}</p>`).join('')}${form}`, { wide: true });
}

// ================================================================== 13.10 the preference centre
const prefToken = (email) => C.signed('prefs', C.lower(email));
const prefsLink = (email) => `${C.baseUrl()}/api/crm-public/b/prefs?t=${prefToken(email)}`;
async function prefsOf(email) {
  const e = C.lower(email);
  const row = await B.one('SELECT * FROM "CrmMailPref" WHERE "email" = ?', e);
  const st = await B.settings();
  const CMP = require('../campaigns'); // eslint-disable-line global-require
  const topics = json(row && row.topicsJson, null);
  return { email: e, topics: st.topics.map((t) => ({ name: t, on: !topics || topics.includes(t) })), channels: json(row && row.channelsJson, { email: true, whatsapp: true, sms: true }), unsubscribed: await CMP.optedOut('email', e) };
}
async function savePrefs(email, body = {}) {
  const e = C.lower(email);
  const st = await B.settings();
  const CMP = require('../campaigns'); // eslint-disable-line global-require
  const DB = require('../schema'); // eslint-disable-line global-require
  if (body.all === 'off') {
    await CMP.optOut('email', e, { reason: 'preference centre: nothing at all' });
    await B.run('INSERT INTO "CrmMailPref" ("email","topicsJson","channelsJson","updatedAt") VALUES (?,?,?,?) ON CONFLICT("email") DO UPDATE SET "topicsJson" = excluded."topicsJson", "channelsJson" = excluded."channelsJson", "updatedAt" = excluded."updatedAt"', e, '[]', JSON.stringify({ email: false, whatsapp: false, sms: false }), B.nowIso());
    return prefsOf(e);
  }
  const pick = [].concat(body.topic || []).map(String).filter((t) => st.topics.includes(t));
  const channels = { email: !!body.ch_email, whatsapp: !!body.ch_whatsapp, sms: !!body.ch_sms };
  await B.run('INSERT INTO "CrmMailPref" ("email","topicsJson","channelsJson","updatedAt") VALUES (?,?,?,?) ON CONFLICT("email") DO UPDATE SET "topicsJson" = excluded."topicsJson", "channelsJson" = excluded."channelsJson", "updatedAt" = excluded."updatedAt"', e, JSON.stringify(pick), JSON.stringify(channels), B.nowIso());
  // the email channel ticked again = back on the list; unticked = off it
  if (channels.email) await DB.run('DELETE FROM "CrmOptOut" WHERE "value" = ? AND "channel" = \'email\' AND "reason" LIKE \'preference centre%\'', e);
  else await CMP.optOut('email', e, { reason: 'preference centre: no email' });
  const rec = await C.recordByEmail(e);
  if (rec) await C.systemActivity(rec.links, { kind: 'note', subject: 'Changed what they receive (preference centre)', note: `Topics: ${pick.join(', ') || 'none'} · Email ${channels.email ? 'yes' : 'no'}, WhatsApp ${channels.whatsapp ? 'yes' : 'no'}, SMS ${channels.sms ? 'yes' : 'no'}`, byName: 'Preference centre' });
  return prefsOf(e);
}
// a campaign message to this address on this topic: no when the person said no to the topic or to the channel (crm/campaigns.js)
async function prefBlocks(channel, addr, topic) {
  if (channel !== 'email') {
    const rec = await C.recordByPhone(addr);
    if (!rec) return false;
    const lead = rec.kind === 'lead' ? await S.getRow('lead', rec.id) : null;
    const e = lead ? C.lower(lead.email) : null;
    if (!e) return false;
    const row = await B.one('SELECT * FROM "CrmMailPref" WHERE "email" = ?', e);
    return !!row && json(row.channelsJson, {})[channel] === false;
  }
  const row = await B.one('SELECT * FROM "CrmMailPref" WHERE "email" = ?', C.lower(addr));
  if (!row) return false;
  if (json(row.channelsJson, {}).email === false) return true;
  const topics = json(row.topicsJson, null);
  return !!topic && Array.isArray(topics) && !topics.includes(topic);
}
function prefsHtml(p, token, saved) {
  const inner = `<h1>What would you like from us?</h1><p>${esc(p.email)}</p>${saved ? '<p style="color:#15803d;font-weight:600">Saved. Thank you.</p>' : ''}
  <form method="post" action="?t=${esc(token)}"><label>Topics</label>${p.topics.map((t) => `<div class="chk"><input type="checkbox" name="topic" value="${esc(t.name)}" id="t-${esc(t.name)}" ${t.on ? 'checked' : ''}><label for="t-${esc(t.name)}" style="margin:0;font-weight:500">${esc(t.name)}</label></div>`).join('')}
  <label>How we may reach you</label>${[['ch_email', 'Email', p.channels.email !== false && !p.unsubscribed], ['ch_whatsapp', 'WhatsApp', p.channels.whatsapp !== false], ['ch_sms', 'SMS', p.channels.sms !== false]].map(([n, l, v]) => `<div class="chk"><input type="checkbox" name="${n}" id="${n}" value="1" ${v ? 'checked' : ''}><label for="${n}" style="margin:0;font-weight:500">${l}</label></div>`).join('')}
  <div class="row"><button>Save my choices</button><button name="all" value="off" style="background:#fff;color:#b91c1c;border:1px solid #fecaca">Send me nothing</button></div></form>
  <p class="muted" style="margin-top:14px">Replies to your own messages and invoices / quotes you asked for still reach you.</p>`;
  return C.page('Your email preferences', inner);
}

module.exports = {
  segments, saveSegment, removeSegment, segmentRows, segmentPreview, segmentAudience, audienceFile, SEG_FIELDS,
  landings, saveLanding, removeLanding, landingHtml, landingView, landingSubmit,
  setCampaignMeta, roi,
  socialPosts, saveSocialPost, postNow, runSocial, saveSocialLinks, setFetch,
  trackView, identify, visitsOf, trackerJs,
  journeys, saveJourney, setJourneyOn, removeJourney, runJourneys, journeyRuns,
  metaLeads, googleLead, adsConfig, metaSignatureOk,
  events, saveEvent, eventRegs, markAttendance, eventOfSlug, register, eventHtml,
  prefsOf, savePrefs, prefBlocks, prefsHtml, prefToken, prefsLink,
};
