// ---------------------------------------------------------------------------
// JOININGS / AGREEMENTS IMPORT 2026-10-17 - PHASE A2: CLIENT NAMES STORED AS TEXT.
// A few tables keep a copy of a client's name as plain text (bank statement "filed as", bank rules, office expenses, partner payouts,
// conversation labels, the Join & Drop record, pending reconciliation proposals). When a client is renamed these copies follow, so the
// whole application shows ONE name. HISTORICAL records are never touched: audit log, sent messages, generated
// invoice / agreement documents, follow-up notes. (The client name written on each history step IS refreshed: the founder wants one name everywhere.) Each changed cell is listed with its old value, so the undo puts it back.
// ---------------------------------------------------------------------------
const q = async (prisma, sql, ...p) => (await prisma.$queryRawUnsafe(sql, ...p)).map((r) => { const o = {}; Object.keys(r).forEach((k) => { o[k] = typeof r[k] === 'bigint' ? Number(r[k]) : r[k]; }); return o; });

async function planDenorm({ prisma, renamed }) {
  const out = []; // { table, pk, id, column, before, after, why }
  if (!renamed.length) return out;
  const tables = new Set((await q(prisma, "SELECT name FROM sqlite_master WHERE type='table'")).map((r) => r.name));
  const cols = {};
  const colsOf = async (t) => { if (!cols[t]) cols[t] = new Set((await q(prisma, `PRAGMA table_info("${t}")`)).map((c) => c.name)); return cols[t]; };
  const byOld = new Map(renamed.map((r) => [r.oldName, r]));
  const byId = new Map(renamed.map((r) => [r.id, r]));
  const add = (table, id, column, before, after, why) => { if (before !== after) out.push({ table, pk: 'id', id, column, before, after, why }); };

  if (tables.has('BankTransaction') && (await colsOf('BankTransaction')).has('clientName')) {
    for (const r of await q(prisma, 'SELECT "id","clientName" FROM "BankTransaction" WHERE "clientName" IS NOT NULL')) {
      const exact = byOld.get(r.clientName);
      if (exact) { add('BankTransaction', r.id, 'clientName', r.clientName, exact.newName, 'bank statement line filed under the client'); continue; }
      const m = /^(.*?)( \+\d+)$/.exec(r.clientName || '');
      if (m && byOld.get(m[1])) add('BankTransaction', r.id, 'clientName', r.clientName, `${byOld.get(m[1]).newName}${m[2]}`, 'bank statement line filed under the client (name + N)');
    }
    if ((await colsOf('BankTransaction')).has('counterparty') && (await colsOf('BankTransaction')).has('categoryKind')) {
      for (const r of await q(prisma, "SELECT \"id\",\"counterparty\" FROM \"BankTransaction\" WHERE \"categoryKind\" = 'refund' AND \"counterparty\" IS NOT NULL")) {
        const x = byOld.get(r.counterparty); if (x) add('BankTransaction', r.id, 'counterparty', r.counterparty, x.newName, 'refund line counterparty');
      }
    }
  }
  if (tables.has('BankRule') && (await colsOf('BankRule')).has('category')) {
    for (const r of await q(prisma, "SELECT \"id\",\"category\" FROM \"BankRule\" WHERE \"kind\" = 'client'")) { const x = byOld.get(r.category); if (x) add('BankRule', r.id, 'category', r.category, x.newName, 'bank rule files lines under the client'); }
  }
  if (tables.has('OfficeExpense') && (await colsOf('OfficeExpense')).has('billableClient')) {
    for (const r of await q(prisma, 'SELECT "id","billableClient" FROM "OfficeExpense" WHERE "billableClient" IS NOT NULL')) { const x = byOld.get(r.billableClient); if (x) add('OfficeExpense', r.id, 'billableClient', r.billableClient, x.newName, 'expense billed to the client'); }
  }
  if (tables.has('PartnerPayout') && (await colsOf('PartnerPayout')).has('clientName')) {
    const rows = await q(prisma, 'SELECT p."id", p."clientName", c."id" AS cid FROM "PartnerPayout" p JOIN "Application" a ON a."id" = p."applicationId" JOIN "Requirement" r ON r."id" = a."requirementId" JOIN "Client" c ON c."id" = r."clientId"');
    rows.forEach((r) => { const x = byId.get(r.cid); if (x) add('PartnerPayout', r.id, 'clientName', r.clientName, x.newName, 'partner payout shows the client'); });
  }
  if (tables.has('Conversation') && (await colsOf('Conversation')).has('personName')) {
    const rows = await q(prisma, "SELECT v.\"id\", v.\"personName\", v.\"personId\", c.\"contactName\" FROM \"Conversation\" v JOIN \"Client\" c ON c.\"id\" = v.\"personId\" WHERE v.\"personType\" = 'CLIENT'");
    rows.forEach((r) => { const x = byId.get(r.personId); if (x) add('Conversation', r.id, 'personName', r.personName, r.contactName ? `${r.contactName} (${x.newName})` : x.newName, 'conversation label'); });
  }
  if (tables.has('JoiningRecord') && (await colsOf('JoiningRecord')).has('clientName')) {
    for (const r of await q(prisma, 'SELECT "id","clientName","clientId" FROM "JoiningRecord" WHERE "clientId" IS NOT NULL')) { const x = byId.get(r.clientId); if (x) add('JoiningRecord', r.id, 'clientName', r.clientName, x.newName, 'Joining and Drop record'); }
  }
  // the client name written on each history step (position history, rejection lists print it): follows the rename too, by the step's client id
  if (tables.has('ApplicationStageEvent') && (await colsOf('ApplicationStageEvent')).has('clientName')) {
    for (const r of await q(prisma, 'SELECT "id","clientName","clientId" FROM "ApplicationStageEvent" WHERE "clientId" IS NOT NULL')) {
      const x = byId.get(r.clientId); if (x) add('ApplicationStageEvent', r.id, 'clientName', r.clientName, x.newName, 'name written on the history step');
    }
  }
  if (tables.has('ReconProposal') && (await colsOf('ReconProposal')).has('party')) {
    for (const r of await q(prisma, "SELECT \"id\",\"party\" FROM \"ReconProposal\" WHERE \"status\" = 'Pending' AND \"party\" IS NOT NULL")) { const x = byOld.get(r.party); if (x) add('ReconProposal', r.id, 'party', r.party, x.newName, 'pending bank match proposal'); }
  }
  return out;
}

module.exports = { planDenorm };
