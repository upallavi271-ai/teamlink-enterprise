// ---------------------------------------------------------------------------
// AI MARKETING > CLIENT APPROVAL > AUTOMATIC REVISION (2026-11-25). The client presses "Changes needed" and writes what to change; TeamLink changes the picture and sends it back by itself:
//   client answer -> a job for THAT answer (once) -> the words are read -> the banner / picture is changed -> the result is CHECKED -> saved as a NEW VERSION (the original stays) -> the SAME client link is
//   opened again showing the newest version -> the client is told (WhatsApp / email, like a person's click) -> the client approves, or asks again, and it repeats (up to MAX_ROUNDS) until approved.
//   * a banner designed in TeamLink (images.js spec): its spec is edited and it is drawn again (marketing/revise.js): the logo, colours, photographs, cards and wording the client did not mention are untouched,
//     the size is the same, nothing is distorted, in a second or two, free. The words are read by plain rules first; ONLY what they leave unclear goes to the AI model (when one is ready), and what it says is checked.
//   * a banner whose picture the AI made, and the client asks about the picture: a NEW picture is made from the first description plus the client's words (images.js heroPicture), then the banner is drawn
//     again, so the wording and the logo stay exact (2026-11-27).
//   * an AI-made picture: the picture AI is given the picture itself as the REFERENCE and told to change only what the client asked (images.js editPicture). Google Gemini, or the free Cloudflare model,
//     which is not asked to change words or the logo (a person does those).
//   * "a completely new design" is its own case: same words, new look (another colour, the next picture), handled as a new version.
// NOT SENT (a person is told, the original and the client's words are kept): the result is empty / corrupt / blank / a different size / no visible change, the words were not understood, the connection failed after
//   retries, no way to reach the client, MAX_ROUNDS used. Each client answer is handled once (a duplicate event does nothing). Admin switch: AI usage > "When a client asks for changes on a banner".
// table OmniMkRevision: one row per client answer (status, version, the words, what was done, what was not, errors, times); the dashboard shows it (AI Images) and the history.
// ---------------------------------------------------------------------------
const S = require('../outreach/store');
const AI = require('./ai');
const Cfg = require('./settings');
const { logAudit } = require('../utils/audit');
const { notifyUsers } = require('../utils/notify');

const T = 'OmniMkRevision';
const DDL = [
  `CREATE TABLE IF NOT EXISTS "${T}" ("id" TEXT NOT NULL PRIMARY KEY, "itemId" TEXT NOT NULL, "reviewId" TEXT NOT NULL, "answerKey" TEXT NOT NULL, "n" INTEGER NOT NULL DEFAULT 1, "status" TEXT NOT NULL DEFAULT 'processing', "kind" TEXT, "method" TEXT, "classification" TEXT, "feedback" TEXT, "summary" TEXT, "unclear" TEXT, "error" TEXT, "attempts" INTEGER NOT NULL DEFAULT 0, "clientName" TEXT, "createdById" TEXT, "createdAt" DATETIME NOT NULL DEFAULT 0, "updatedAt" DATETIME NOT NULL DEFAULT 0, "finishedAt" DATETIME, "sentAt" DATETIME)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "${T}_answer" ON "${T}"("answerKey")`,
  `CREATE INDEX IF NOT EXISTS "${T}_item" ON "${T}"("itemId", "createdAt")`,
];
let okAt = 0;
async function ensure() { if (okAt && Date.now() - okAt < 600000) return true; try { for (const sql of DDL) await S.run(sql); okAt = Date.now(); return true; } catch (e) { console.error('[omni-mk] revision schema:', e.message); return false; } } // eslint-disable-line no-await-in-loop, no-console

const MAX_ROUNDS = 10; const PLACEHOLDER = /^\(reason asked on WhatsApp\)$/;
const LABELS = { processing: 'AI Processing', completed: 'Revision Completed', sent: 'Waiting for Client Approval', failed: 'Revision Failed', 'needs-person': 'Changes Requested' };
const hooks = { tell: null, editFn: null, makeFn: null, ask: null, waitMs: 1500 }; // a test answers instead of WhatsApp / the picture AI / the text AI, and does not wait between tries
const parse = (v, d) => { try { return typeof v === 'string' ? JSON.parse(v) : (v == null ? d : v); } catch { return d; } };
const sleep = (ms) => new Promise((res) => { setTimeout(res, ms); });
const transient = (e) => !!e && !['not_ready', 'limit', 'unsupported', 'invalid', 'refused', 'corrupt'].includes(e.code) && (e.status >= 500 || e.status === 429 || e.status === 408 || /unreachable|timeout|timed out|temporar|try again|ECONN|socket|network|overloaded/i.test(`${e.code || ''} ${e.error || e.message || ''}`));
// try up to `tries` times while the answer is a TEMPORARY failure ({ error, status 5xx / 429 } or a thrown network error); the last answer is returned
async function retry(fn, tries = 3, count = null) {
  let last;
  for (let i = 1; i <= tries; i += 1) {
    if (count) count.n += 1;
    try { last = await fn(i); } catch (e) { last = { error: e.message || 'failed', status: e.status || 503, code: e.code }; } // eslint-disable-line no-await-in-loop
    if (!last || !last.error || !transient(last) || i === tries) return last;
    await sleep(hooks.waitMs * i); // eslint-disable-line no-await-in-loop
  }
  return last;
}
// the result must be a real picture of the same size that really differs from the one before; checked BEFORE it replaces anything
async function validate(before, after) {
  try {
    const sharp = require('sharp'); // eslint-disable-line global-require
    if (!after || after.length < 2000) return { ok: false, reason: 'The new picture is empty or far too small.' };
    const m = await sharp(after).metadata(); if (!m.width || !m.height) return { ok: false, reason: 'The new picture could not be read.' };
    if (before) { const b = await sharp(before).metadata(); if (b.width !== m.width || b.height !== m.height) return { ok: false, reason: `The new picture is ${m.width}×${m.height}, not ${b.width}×${b.height} like the original.` }; if (Buffer.compare(before, after) === 0) return { ok: false, reason: 'The changes made no visible difference to the picture.' }; }
    const st = await sharp(after).stats(); const sd = st.channels.slice(0, 3).reduce((a, c) => a + c.stdev, 0) / 3; if (sd < 6) return { ok: false, reason: 'The new picture looks blank.' };
    return { ok: true };
  } catch { return { ok: false, reason: 'The new picture is damaged and could not be read.' }; }
}

const rowById = async (id) => (await S.q(`SELECT * FROM "${T}" WHERE id = ?`, String(id || '')))[0] || null;
const outOf = (r) => ({ id: r.id, itemId: r.itemId, reviewId: r.reviewId, version: S.num(r.n) + 1, status: r.status, label: LABELS[r.status] || r.status, kind: r.kind || '', method: r.method || '', classification: r.classification || '', feedback: r.feedback || '', summary: parse(r.summary, []), unclear: parse(r.unclear, []), error: r.error || '', attempts: S.num(r.attempts), clientName: r.clientName || '', createdAt: S.iso(r.createdAt), finishedAt: S.iso(r.finishedAt), sentAt: S.iso(r.sentAt) });
async function senderOf(createdById) { try { return await require('../db').user.findFirst({ where: { id: String(createdById || ''), status: 'Active' } }); } catch { return null; } } // eslint-disable-line global-require

// the latest revision of each item, for the AI Images cards (one query for the whole list): { revision: { version, status, label, feedback, at, ... , count } } + the approval label
async function attach(items) {
  await ensure(); const list = Array.isArray(items) ? items : []; const ids = list.map((i) => i.id).slice(0, 900); if (!ids.length) return list;
  const rows = await S.q(`SELECT * FROM "${T}" WHERE itemId IN (${ids.map(() => '?').join(',')}) ORDER BY createdAt DESC`, ...ids);
  const latest = {}; const count = {}; rows.forEach((r) => { if (!latest[r.itemId]) latest[r.itemId] = r; count[r.itemId] = (count[r.itemId] || 0) + 1; });
  return list.map((it) => { const r = latest[it.id]; if (!r) return it; const o = outOf(r); return { ...it, revision: { ...o, count: count[it.id], label: it.status === 'approved' ? 'Approved' : o.label } }; });
}
// every change asked for on one picture, oldest first: the client's words, what was done, and the version it made (0 = the original)
async function history(u, itemId) {
  await ensure(); const Img = require('./images'); // eslint-disable-line global-require
  const g = await Img.getRow(u, itemId); if (!g) return { error: 'This picture was not found.', status: 404 };
  const rows = await S.q(`SELECT * FROM "${T}" WHERE itemId = ? ORDER BY createdAt ASC`, g.r.id);
  return { itemId: g.r.id, title: g.r.title, version: Img.versionOf(g.r) + 1, original: true, revisions: rows.map(outOf) };
}

// ---- the job ------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// reviewId: the client link whose answer asked for changes. opts: { force (a person pressed Retry) }. -> { skipped } | { revision, sent, ... } (the row is in the dashboard as it goes)
async function run(reviewId, opts = {}) {
  await ensure(); const CR = require('./clientReview'); await CR.ensure(); // eslint-disable-line global-require
  const r = await CR.rowOf(reviewId);
  if (!r || r.deletedAt || r.kind !== 'image' || r.mode !== 'decide' || r.status !== 'changes') return { skipped: 'not a client request for changes' };
  const comment = String(r.comment || '').trim(); if (comment.length < 5 || PLACEHOLDER.test(comment)) return { skipped: 'the client has not said what to change yet' };
  if ((await Cfg.getSettings()).autoRevise === false) return { skipped: 'switched off' };
  const Img = require('./images'); const Rev = require('./revise'); // eslint-disable-line global-require
  const item = await Img.rawRow(r.itemId); if (!item || item.deletedAt || ['clip', 'video', 'upload'].includes(item.style) || Img.isVideoRow(item)) return { skipped: 'not a picture TeamLink can change' };
  const answerKey = `${r.id}:${S.num(r.decidedAt)}`; const id = S.newId('rvn'); const now = Date.now(); const title = S.clip(r.itemTitle, 60); const who = S.clip(r.clientName, 60);
  const prevSpec = parse(item.spec, null) || {}; const round = Number(prevSpec.rev) || 0; const kind = item.style === 'banner' ? 'banner' : 'picture';
  try { await S.run(`INSERT INTO "${T}" (id, itemId, reviewId, answerKey, n, status, kind, feedback, clientName, createdById, createdAt, updatedAt) VALUES (?,?,?,?,?,'processing',?,?,?,?,?,?)`, id, item.id, r.id, answerKey, round, kind, S.clip(comment, 600), who, r.createdById || null, now, now); } catch { return { skipped: 'already handled' }; } // one job per client answer
  const tellTeam = async (head, message) => { if (r.createdById) { try { await notifyUsers([r.createdById], { title: head, message: S.clip(message, 420) }); } catch { /* a notice that cannot be made does not stop the job */ } } };
  const finish = async (status, fields = {}) => { const f = { status, ...fields }; const sets = Object.keys(f).map((k) => `"${k}" = ?`).join(', '); await S.run(`UPDATE "${T}" SET ${sets}, finishedAt = ?, updatedAt = ? WHERE id = ?`, ...Object.values(f).map((v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v)), Date.now(), Date.now(), id); };
  const needsPerson = async (reason, extra = {}) => { await finish('needs-person', { error: S.clip(reason, 300), ...extra }); await tellTeam(`Client changes on "${title}": please change it`, `${who} asked for changes: "${S.clip(comment, 200)}". ${reason} The original picture and the client's words are kept: open AI Images, change it and send it again.`); return { revision: outOf(await rowById(id)), needsPerson: reason }; };
  const failed = async (reason) => { await finish('failed', { error: S.clip(reason, 300) }); await tellTeam(`Revision failed on "${title}"`, `${who} asked for changes: "${S.clip(comment, 200)}". TeamLink could not make the new picture: ${reason} The original picture is unchanged. Open AI Images and press Try again, or change it yourself.`); return { revision: outOf(await rowById(id)), failed: reason }; };
  if (round >= MAX_ROUNDS) return needsPerson(`The picture was changed automatically ${MAX_ROUNDS} times already.`);
  const u = await senderOf(r.createdById); if (!u || !require('../outreach/access').has('mayAiMarketing')(u)) return needsPerson('The person who sent it can no longer make pictures here.'); // eslint-disable-line global-require
  const attempts = { n: 0 };

  // 1 read the words and change the picture (checked before it replaces anything)
  const ask = hooks.ask || (async (req) => { const out = await AI.generate({ user: u, module: 'revision', task: 'interpret', system: req.system, prompt: req.prompt, json: true, itemId: item.id, quickMs: 25000, demo: () => null }); return out.result; });
  const handled = [...(prevSpec.handled || []).slice(-9), answerKey]; let made; let understood = { summary: [], unclear: [], method: 'rules', classification: 'correction', confidence: 1 };
  if (kind === 'banner') {
    if (!prevSpec.headline) return needsPerson('This banner was made before TeamLink could change banners by itself.');
    const heroRow = prevSpec.photoItemId ? await Img.rawRow(prevSpec.photoItemId) : null; // was the banner's picture made by the AI? then a request about it makes a new one
    const heroAi = Img.isAiPicture(heroRow);
    understood = await Rev.understand({ ...prevSpec, heroAi }, comment, { ask });
    if (!understood.changes.length) return needsPerson(understood.unclear.length ? `TeamLink could not turn "${S.clip(understood.unclear.join(' / '), 120)}" into a change by itself.` : 'TeamLink could not turn the words into a change by itself.', { method: understood.method, classification: understood.classification, unclear: understood.unclear });
    if (understood.confidence < 0.5) return needsPerson('TeamLink was not sure what the client meant.', { method: understood.method, unclear: understood.unclear });
    const nextSpec = { ...understood.spec }; const wish = nextSpec.heroRedo; delete nextSpec.heroRedo; delete nextSpec.heroAi;
    if (wish) {
      const wishes = [...(prevSpec.heroWishes || []), wish].slice(-3);
      const got = await retry(() => Img.heroPicture(u, item.id, heroRow, wishes, { makeFn: hooks.makeFn }), 3, attempts);
      if (got && got.file) { nextSpec.heroFile = got.file; nextSpec.heroWishes = wishes; }
      else { // no new picture: the other changes still go ahead and the picture is left for a person; with nothing else to change, nothing is sent
        const why = (got && got.error) || 'unknown error';
        const rest = (understood.changes || []).filter((c) => !['photo', 'newDesign'].includes(c.key));
        const redesign = understood.classification === 'new_design';
        if (!rest.length && !redesign) return needsPerson(`A new picture could not be made: ${why}`, { method: understood.method, unclear: [wish] });
        understood = { ...understood, summary: redesign ? ['Made a new design with the same words: changed the colours.'] : rest.map((c) => c.text), unclear: [...understood.unclear, S.clip(`the new picture (${why})`, 160)] };
      }
    }
    const note = `Changed automatically after the client's request: ${understood.summary.join(' ')}`;
    made = await retry(() => Img.reviseBanner(u, item.id, { ...nextSpec, handled }, note, validate), 3, attempts);
  } else {
    // the LOGO (2026-11-25): "keep the logo top left and bigger" is done by TeamLink itself, with no AI model (images.js changeLogo); anything else the client wrote about the picture is listed as not done
    const lr = Rev.logoRequest(comment);
    if (lr && !Img.logoWhy(item, lr.add)) {
      understood = { summary: ['Changed the logo as the client asked.'], unclear: lr.rest, method: 'rules', classification: 'correction', confidence: 1 };
      made = await retry(() => Img.changeLogo(u, item.id, lr, { check: validate, instruction: comment }), 3, attempts);
      if (made && made.summary) understood.summary = [made.summary];
      if (made && ['unsupported', 'not_ready'].includes(made.code)) return needsPerson(made.error);
    } else {
      if (Rev.classify(comment) === 'new_design') return needsPerson('The client wants a completely new picture, which has to be made again.', { classification: 'new_design' });
      understood = { summary: [`Changed the picture as the client asked: "${S.clip(comment, 140)}"`], unclear: [], method: 'ai-edit', classification: 'correction', confidence: 1 };
      made = await retry(() => Img.editPicture(u, item.id, comment, { editFn: hooks.editFn, check: validate }), 3, attempts);
      if (made && ['unsupported', 'not_ready', 'limit'].includes(made.code)) return needsPerson(made.error);
    }
  }
  if (!made || made.error) { if (made && ['invalid', 'corrupt', 'refused'].includes(made.code)) return needsPerson(`The new picture was not good enough to send: ${made.error}`, { method: understood.method, unclear: understood.unclear }); return failed((made && made.error) || 'unknown error'); }
  // the spec of a picture made by the AI edit has no "handled" list yet: add it, so a second event for the same answer does nothing even if the revision row were lost
  try { await Img.saveSpec(item.id, { ...made.spec, handled }); } catch { /* the revision row already guards against a repeat */ }
  const summary = understood.summary; const version = (Number(made.spec.rev) || round + 1) + 1;
  await finish('completed', { n: Number(made.spec.rev) || round + 1, method: understood.method, classification: understood.classification, summary, unclear: understood.unclear, attempts: attempts.n });

  // 2 the SAME client link is opened again with the newest version, and the client is told
  const message = Rev.clientNote({ summary, unclear: understood.unclear });
  const reopened = await CR.reopen(r.id, { message, user: u });
  if (reopened.error) { await tellTeam(`Client changes on "${title}": made, not sent`, `The picture was changed (${summary.join(' ')}) but the client's link could not be opened again: ${reopened.error} Open AI Images and send it again.`); return { revision: outOf(await rowById(id)), revised: true, sent: null }; }
  await Img.setNote(item.id, `Version ${version} (changed automatically after the client's request): ${summary.join(' ')}`);
  const ways = r.contactPhone ? ['whatsapp'] : (r.contactEmail ? ['email'] : []);
  if (!ways.length) { await tellTeam(`Client changes on "${title}": made, not sent`, `The picture was changed (${summary.join(' ')}) but there is no WhatsApp number or email for ${who}. Open AI Images and send it.`); return { revision: outOf(await rowById(id)), revised: true, sent: null }; }
  const tellFn = opts.tell || hooks.tell || CR.tell;
  const sent = await retry(() => tellFn(u, r.id, { ways }, opts.base || r.site || ''), 2, null); // the site address kept when the link was first sent (clientReview.js tell), else the server's APP_BASE_URL
  const ok = !!sent && !sent.error;
  await S.run(`UPDATE "${T}" SET status = ?, sentAt = ?, error = ?, updatedAt = ? WHERE id = ?`, ok ? 'sent' : 'completed', ok ? Date.now() : null, ok ? null : S.clip((sent && sent.error) || 'not sent', 300), Date.now(), id);
  await tellTeam(ok ? `Changed and sent again: "${title}" (version ${version})` : `Client changes on "${title}": made, not sent`,
    `${who} asked: "${S.clip(comment, 160)}". TeamLink changed it (${summary.join(' ')})${understood.unclear.length ? `, but could not do: "${S.clip(understood.unclear.join(' / '), 120)}"` : ''}. ${ok ? `Version ${version} was sent to the client on the same link.` : `It was NOT sent: ${S.clip((sent && sent.error) || 'unknown', 160)} Open AI Images and send it.`}`);
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: picture changed by itself after a client request', entity: T, entityId: id, toValue: `${r.itemTitle}: version ${version}: ${summary.join(' ')}${understood.unclear.length ? ` | not done: ${S.clip(understood.unclear.join(' / '), 120)}` : ''}; ${ok ? 'sent again' : 'not sent'}` });
  return { revision: outOf(await rowById(id)), revised: true, changes: summary, unclear: understood.unclear, sent, version };
}

// a person presses "Try again" on a revision that FAILED (a temporary problem): the same client answer is run again; or on one that was made but NOT SENT: the client is sent the newest version
async function retryJob(u, revisionId, base = '') {
  await ensure(); const rv = await rowById(revisionId); if (!rv) return { error: 'This revision was not found.', status: 404 };
  const Img = require('./images'); const g = await Img.getRow(u, rv.itemId); if (!g) return { error: 'This picture was not found.', status: 404 };
  const CR = require('./clientReview'); // eslint-disable-line global-require
  if (rv.status === 'failed') { await S.run(`UPDATE "${T}" SET answerKey = ?, updatedAt = ? WHERE id = ?`, `${rv.answerKey}:retired:${Date.now()}`, Date.now(), rv.id); return run(rv.reviewId, { base }); }
  if (rv.status === 'completed') { const r = await CR.rowOf(rv.reviewId); if (!r) return { error: 'The client link was not found.', status: 404 }; const out = await (hooks.tell || CR.tell)(u, r.id, { ways: r.contactPhone ? ['whatsapp'] : ['email'] }, base || r.site || ''); if (out && !out.error) await S.run(`UPDATE "${T}" SET status = 'sent', sentAt = ?, error = NULL, updatedAt = ? WHERE id = ?`, Date.now(), Date.now(), rv.id); return out && out.error ? out : { ok: out.ok, revision: outOf(await rowById(rv.id)) }; }
  if (rv.status === 'needs-person') { // "Changes Requested": nothing was made; the client's answer is still waiting, so it is run again (after an update that can do more, or when a person wants TeamLink to try once more)
    const r = await CR.rowOf(rv.reviewId); if (!r || r.deletedAt || r.status !== 'changes') return { error: 'The client\'s request has already been dealt with.', status: 409 };
    await S.run(`UPDATE "${T}" SET answerKey = ?, updatedAt = ? WHERE id = ?`, `${rv.answerKey}:retired:${Date.now()}`, Date.now(), rv.id); return run(rv.reviewId, { base });
  }
  return { error: 'Only a failed revision can be tried again, or one that was made but not sent.', status: 409 };
}

module.exports = { ensure, run, retryJob, attach, history, validate, retry, outOf, LABELS, MAX_ROUNDS, hooks };
