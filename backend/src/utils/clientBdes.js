// ---------------------------------------------------------------------------
// WHO LOOKS AFTER A CLIENT ON THE BDE SIDE (user, 2026-10-10: "everything about a client must
// reach the BDE, from the moment the client is added").
//
// A job names its BDE in Requirement.bdeId — but most client jobs name none: the BDE is named on
// the CLIENT (Client.bdeOwner = Owner BDE, Client.secondaryBde = second BDE; both hold NAMES). So
// every notice about "this job's people" that only read bdeId missed the client's own BDE. This
// is the one place that answers it:
//
//   ownerBdeIds(requirement)       job BDE + Owner BDE + second BDE (active logins)
//   withClientBdes(ids, requirement)   the same ids with those BDEs added (de-duplicated)
//   bdeTlIds()                     the BDE team lead(s), for the events that concern every client
//
// Test logins (ZZTEST / example.test) are never resolved except in the test sandbox (TEST_MODE),
// where the fixtures ARE the people being notified.
// ---------------------------------------------------------------------------
const prisma = require('../db');

const TEST_RE = /zztest|example\.test/i;
const skipTest = (u) => !process.env.TEST_MODE && TEST_RE.test(`${u.name} ${u.email}`);
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
let CACHE = { at: 0, byName: new Map(), tls: [] };

async function load() {
  if (Date.now() - CACHE.at < 15000) return CACHE;
  const users = await prisma.user.findMany({
    where: { status: 'Active', OR: [{ atsRole: 'BDE' }, { role: 'BDE' }, { atsRole: 'TL', OR: [{ atsDepartment: 'BDE' }, { atsScopeDepartments: { contains: 'BDE' } }] }] },
    select: { id: true, name: true, email: true, atsRole: true },
  });
  const byName = new Map();
  const dup = new Set();
  const tls = [];
  users.filter((u) => !skipTest(u)).forEach((u) => {
    const k = norm(u.name);
    if (byName.has(k)) dup.add(k); else byName.set(k, u.id);
    if (u.atsRole === 'TL') tls.push(u.id);
  });
  dup.forEach((k) => byName.delete(k)); // an ambiguous name names nobody
  CACHE = { at: Date.now(), byName, tls };
  return CACHE;
}

// requirement: { bdeId, clientId, client?: { bdeOwner, secondaryBde } }
async function ownerBdeIds(requirement) {
  const r = requirement || {};
  const { byName } = await load();
  let client = r.client && (r.client.bdeOwner !== undefined || r.client.secondaryBde !== undefined) ? r.client : null;
  if (!client && r.clientId) client = await prisma.client.findUnique({ where: { id: r.clientId }, select: { bdeOwner: true, secondaryBde: true } }).catch(() => null);
  const ids = [r.bdeId];
  if (client && !r.internal) {
    [client.bdeOwner, client.secondaryBde].forEach((n) => { if (n) ids.push(byName.get(norm(n))); });
  }
  return [...new Set(ids.filter(Boolean))];
}

async function withClientBdes(ids, requirement) {
  return [...new Set([...(ids || []).filter(Boolean), ...(await ownerBdeIds(requirement))])];
}

async function bdeTlIds() {
  return (await load()).tls.slice();
}

module.exports = { ownerBdeIds, withClientBdes, bdeTlIds };
