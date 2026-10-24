// ---------------------------------------------------------------------------
// CLEAN-UP SUGGESTIONS FOR THE SOURCE WORDS — the in-app twin of
// scripts/normalise-candidate-source.js (same rules: utils/candidateSource.js,
// same safety, same undo style). Used by the Sources tab (Admin / Super Admin):
//
//   suggestions()                 read-only: stored words that the clean list would
//                                 write differently, grouped by the clean source
//   preview(target, words)        what an "apply" of one group would change (counts + a few names)
//   apply(user, target, words)    writes the clean word (backup-style undo file first, one audit row per
//                                 model), keeps the old word in firstSource, never touches the
//                                 functional portal markers on applications
//   undo(user, id)                puts every word of one apply back
//
// Nothing is deleted. The screen asks the Admin to confirm; the endpoint asks again (confirm:true).
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const prisma = require('../db');
const CS = require('./candidateSource');
const { logAudit } = require('./audit');
const { markCandidateDirty } = require('./candidateListCache');

const KEEP_AS_IS = new Set(['teamlink job portal', 'job portal', 'hr sourcing']); // functional Application.source markers
const n = (x) => Number(x || 0);
const squash = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const short = (s, w) => (String(s).length > w ? `${String(s).slice(0, w - 1)}…` : String(s));

function undoRoot() {
  const root = require('./backup').backupRoot(); // eslint-disable-line global-require
  fs.mkdirSync(root, { recursive: true });
  return root;
}

// Stored words that differ from their clean source, grouped by the clean source.
async function suggestions() {
  const [cs, as] = await Promise.all([
    prisma.candidate.groupBy({ by: ['source'], _count: { _all: true } }),
    prisma.application.groupBy({ by: ['source'], _count: { _all: true } }),
  ]);
  const words = new Map();
  const add = (raw, count, field) => {
    if (raw == null || squash(raw) === '') return; // blank stays blank: nothing to tidy
    if (!words.has(raw)) words.set(raw, { word: raw, people: 0, apps: 0 });
    words.get(raw)[field] += n(count);
  };
  cs.forEach((x) => add(x.source, x._count._all, 'people'));
  as.forEach((x) => add(x.source, x._count._all, 'apps'));
  const groups = new Map();
  words.forEach((w) => {
    const target = CS.canonicalSource(w.word);
    if (target === w.word) return; // already the clean word
    if (!groups.has(target)) groups.set(target, { target, words: [], people: 0, apps: 0 });
    const g = groups.get(target);
    const keep = KEEP_AS_IS.has(squash(w.word).toLowerCase());
    g.words.push({ ...w, keepOnApplications: keep, why: CS.explain(w.word).rule });
    g.people += w.people;
    g.apps += keep ? 0 : w.apps;
  });
  const out = [...groups.values()].map((g) => ({
    ...g,
    // 'spelling' = the same place written differently (Naukri / naukri.com); 'sheet' = not a place at all, an old sheet's name or a note.
    kind: g.target === CS.IMPORTED ? 'sheet' : 'spelling',
    words: g.words.sort((a, b) => (b.people + b.apps) - (a.people + a.apps)),
  }));
  out.sort((a, b) => (a.kind === b.kind ? (b.people + b.apps) - (a.people + a.apps) : (a.kind === 'spelling' ? -1 : 1)));
  return out;
}

// Which stored words an apply would touch: the asked words, restricted to the ones that really map to `target`.
async function plan(target, onlyWords) {
  const groups = await suggestions();
  const g = groups.find((x) => x.target === target);
  if (!g) return { group: null, words: [] };
  const wanted = Array.isArray(onlyWords) && onlyWords.length ? new Set(onlyWords.map(String)) : null;
  return { group: g, words: g.words.filter((w) => !wanted || wanted.has(w.word)) };
}

async function preview(target, onlyWords) {
  const { group, words } = await plan(target, onlyWords);
  if (!group) return { target, people: 0, applications: 0, words: [], sample: [] };
  const raws = words.map((w) => w.word);
  const sample = raws.length ? await prisma.candidate.findMany({ where: { source: { in: raws } }, select: { name: true, source: true }, take: 8, orderBy: { createdAt: 'desc' } }) : [];
  return {
    target,
    kind: group.kind,
    people: words.reduce((s, w) => s + w.people, 0),
    applications: words.reduce((s, w) => s + (w.keepOnApplications ? 0 : w.apps), 0),
    words: words.map((w) => ({ word: w.word, people: w.people, apps: w.keepOnApplications ? 0 : w.apps, why: w.why })),
    sample: sample.map((c) => ({ name: c.name, was: c.source })),
    keepsOldWord: true,
    note: 'The old word stays on file (the first-source box and the undo file). Nothing is deleted. The "Last update" of the changed applications is refreshed.',
  };
}

async function apply(user, target, onlyWords) {
  const { group, words } = await plan(target, onlyWords);
  if (!group || !words.length) return { ok: true, changedPeople: 0, changedApplications: 0, undoId: null, message: 'Nothing to change.' };
  const at = new Date().toISOString();
  const undo = { at, by: user ? { id: user.id, name: user.name } : null, target, groups: [] };
  for (const w of words) {
    for (const model of ['candidate', 'application']) {
      if (model === 'application' && w.keepOnApplications) continue; // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      const ids = (await prisma[model].findMany({ where: { source: w.word }, select: { id: true } })).map((r) => r.id);
      if (!ids.length) continue; // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      const emptyFirst = (await prisma[model].findMany({ where: { id: { in: ids }, firstSource: null }, select: { id: true } })).map((r) => r.id);
      undo.groups.push({ model, old: w.word, now: target, ids, firstSourceFilled: emptyFirst });
    }
  }
  const file = path.join(undoRoot(), `source-tidy-undo-${at.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(undo)); // the undo file first, then the change
  await prisma.$transaction(async (tx) => {
    for (const grp of undo.groups) {
      for (let i = 0; i < grp.ids.length; i += 400) {
        const chunk = grp.ids.slice(i, i + 400);
        const fill = grp.firstSourceFilled.filter((id) => chunk.includes(id));
        // eslint-disable-next-line no-await-in-loop
        if (fill.length) await tx[grp.model].updateMany({ where: { id: { in: fill }, firstSource: null }, data: { firstSource: short(grp.old, 190) } });
        // eslint-disable-next-line no-await-in-loop
        await tx[grp.model].updateMany({ where: { id: { in: chunk }, source: grp.old }, data: { source: grp.now } });
      }
    }
  }, { timeout: 600000, maxWait: 30000 });
  const people = undo.groups.filter((g) => g.model === 'candidate').reduce((s, g) => s + g.ids.length, 0);
  const apps = undo.groups.filter((g) => g.model === 'application').reduce((s, g) => s + g.ids.length, 0);
  undo.groups.filter((g) => g.model === 'candidate').forEach((g) => g.ids.forEach((id) => markCandidateDirty(id)));
  await logAudit({
    userId: user ? user.id : null,
    actorName: user ? user.name : 'System',
    action: 'Source tidied (Sources tab)',
    entity: 'Candidate',
    entityId: 'bulk',
    fromValue: short(words.map((w) => w.word).join(' | '), 190),
    toValue: target,
    reason: `${people} people and ${apps} applications now say "${target}". The old words are kept in the first-source box and in the undo file ${path.basename(file)}.`,
  });
  return { ok: true, changedPeople: people, changedApplications: apps, undoId: path.basename(file), message: `${people} people and ${apps} applications now say "${target}".` };
}

async function undo(user, id) {
  const base = path.basename(String(id || ''));
  if (!/^source-tidy-undo-[\w.-]+\.json$/.test(base)) throw Object.assign(new Error('That undo file name is not valid.'), { status: 400 });
  const file = path.join(undoRoot(), base);
  if (!fs.existsSync(file)) throw Object.assign(new Error('That undo file was not found.'), { status: 404 });
  const u = JSON.parse(fs.readFileSync(file, 'utf8'));
  let rows = 0;
  await prisma.$transaction(async (tx) => {
    for (const grp of u.groups) {
      for (let i = 0; i < grp.ids.length; i += 400) {
        const chunk = grp.ids.slice(i, i + 400);
        // eslint-disable-next-line no-await-in-loop
        rows += (await tx[grp.model].updateMany({ where: { id: { in: chunk }, source: grp.now }, data: { source: grp.old } })).count;
        const fill = grp.firstSourceFilled.filter((x) => chunk.includes(x));
        // eslint-disable-next-line no-await-in-loop
        if (fill.length) await tx[grp.model].updateMany({ where: { id: { in: fill }, firstSource: short(grp.old, 190) }, data: { firstSource: null } });
      }
    }
  }, { timeout: 600000, maxWait: 30000 });
  u.groups.filter((g) => g.model === 'candidate').forEach((g) => g.ids.forEach((x) => markCandidateDirty(x)));
  await logAudit({ userId: user ? user.id : null, actorName: user ? user.name : 'System', action: 'Source tidy undone (Sources tab)', entity: 'Candidate', entityId: 'bulk', reason: `Undo of ${base}: ${rows} rows` });
  try { fs.renameSync(file, `${file}.undone`); } catch { /* the file stays; a second undo finds nothing to put back */ }
  return { ok: true, rows };
}

module.exports = { suggestions, preview, apply, undo };
