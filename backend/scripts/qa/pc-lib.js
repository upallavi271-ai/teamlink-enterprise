// Posting-and-Channels test lib — SANDBOX ONLY.
const TLT = require('./tl-target');
if (!TLT.sandbox) throw new Error('sandbox only');
const path = require('path');
const BACK = 'C:/Users/user/Desktop/All_Projects/teamlink-enterprise/backend';
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env') });
process.env.DATABASE_URL = TLT.DATABASE_URL;
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const { PrismaClient } = require(path.join(BACK, 'node_modules/@prisma/client'));
const prisma = new PrismaClient({ datasources: { db: { url: TLT.DATABASE_URL } } });
const API = TLT.API;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let TOKEN;
async function api(method, p, body, raw) {
  for (let i = 0; i < 30; i += 1) {
    try {
      const res = await fetch(`${API}${p}`, { method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      if (raw) return res;
      const text = await res.text();
      let json = null; try { json = JSON.parse(text); } catch { json = text; }
      return { code: res.status, body: json };
    } catch (e) { await sleep(2000); }
  }
  throw new Error('API down');
}
async function login() {
  // a ZZTEST Super Admin of its own: the real one may still be on a starting password (403 PASSWORD_CHANGE_REQUIRED). zz-clean.js removes it.
  const tag = Date.now().toString(36);
  const sa = await prisma.user.create({ data: { name: `ZZTEST PC SA ${tag}`, email: `zztest.pcsa.${tag}@example.test`, passwordHash: `!disabled-${tag}`, role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN', hrmsRole: 'SUPER_ADMIN', status: 'Active', atsAccess: true, hrmsAccess: true, accountsAccess: true } });
  TOKEN = jwt.sign({ id: sa.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
  return sa;
}
let pass = 0; let fail = 0;
function check(name, ok, extra) { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra ? '  :: ' + extra : ''}`); }
module.exports = { prisma, api, login, check, sleep, results: () => ({ pass, fail }), BACK, API, TLT };
