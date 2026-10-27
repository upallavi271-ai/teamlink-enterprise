#!/usr/bin/env node
/* eslint-disable no-console, no-await-in-loop */
// ---------------------------------------------------------------------------
// AFTER THE ATS RESET + JOININGS IMPORT (2026-10-27): the joinings import creates a client when a sheet names a college it cannot find
// among the ACTIVE clients - also when that college is already on file as an Inactive client (kept for joinings history). Such a new
// client is folded into the existing one (its requirements and invoices move over, then it is removed); any other new client that is not
// a zip client (no signed agreement on file) is set Inactive, as the founder decided ("only zip clients are Active").
//
//   node scripts/finish-ats-reset-clients.js --since <ISO time the reset started>                 DRY RUN
//   TL_ALLOW_REAL_APPLY=1 node scripts/finish-ats-reset-clients.js --since <ISO> --apply --really-real      (--db <copy.db> on a copy)
// ---------------------------------------------------------------------------
const path = require('path');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const BACK = path.resolve(__dirname, '..');
const DEV_DB = path.join(BACK, 'prisma', 'dev.db');
const dbArg = path.resolve(val('--db', DEV_DB));
const isReal = dbArg.toLowerCase() === DEV_DB.toLowerCase();
const APPLY = has('--apply');
const SINCE = val('--since');
if (!SINCE || Number.isNaN(new Date(SINCE).getTime())) { console.error('Give --since <ISO time the reset started>'); process.exit(2); }
if (APPLY && isReal && !(has('--really-real') && process.env.TL_ALLOW_REAL_APPLY === '1')) { console.error('REFUSED: needs --really-real AND TL_ALLOW_REAL_APPLY=1.'); process.exit(2); }
process.chdir(BACK);
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({ datasources: { db: { url: `file:${dbArg.split(path.sep).join('/')}` } } });
const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

(async () => {
  try {
    const zip = new Set((await prisma.clientDocument.findMany({ where: { kind: 'AGREEMENT_SIGNED' }, select: { clientId: true } })).map((d) => d.clientId));
    const all = await prisma.client.findMany({ select: { id: true, name: true, status: true, createdAt: true } });
    const fresh = all.filter((c) => new Date(c.createdAt) >= new Date(SINCE) && !zip.has(c.id));
    const plan = fresh.map((c) => {
      const older = all.find((o) => o.id !== c.id && key(o.name) === key(c.name) && new Date(o.createdAt) < new Date(SINCE));
      return { c, into: older || null };
    });
    plan.forEach((x) => console.log(x.into ? `fold "${x.c.name}" into the existing ${x.into.status} client` : `set "${x.c.name}" Inactive (not a zip client)`));
    if (!plan.length) console.log('Nothing to do: no new non-zip client.');
    if (!APPLY || !plan.length) { if (!APPLY) console.log('\nDRY RUN: nothing was changed.'); return; }
    await prisma.$transaction(async (tx) => {
      for (const { c, into } of plan) {
        if (into) {
          await tx.requirement.updateMany({ where: { clientId: c.id }, data: { clientId: into.id } });
          await tx.invoice.updateMany({ where: { clientId: c.id }, data: { clientId: into.id } }).catch(() => null);
          await tx.$executeRawUnsafe('UPDATE "JoiningRecord" SET "clientId" = ?, "clientName" = ? WHERE "clientId" = ?', into.id, into.name, c.id).catch(() => null);
          await tx.client.delete({ where: { id: c.id } });
        } else {
          await tx.client.update({ where: { id: c.id }, data: { status: 'Inactive' } });
        }
      }
      await tx.auditLog.create({ data: { action: `ATS reset: ${plan.filter((x) => x.into).length} duplicate client(s) folded, ${plan.filter((x) => !x.into).length} set Inactive`, entity: 'Client', actorName: 'ATS reset 2026-10-27' } });
    });
    console.log('\nDONE.');
  } finally { await prisma.$disconnect(); }
})().catch((e) => { console.error(String(e && e.stack ? e.stack : e).slice(0, 900)); process.exit(1); });
