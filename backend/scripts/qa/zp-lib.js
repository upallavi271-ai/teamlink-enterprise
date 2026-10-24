const TLT = require('./tl-target');
if (!TLT.sandbox) throw new Error('Run with TL_API=http://localhost:4011');
const path = require('path');
const BACK = 'C:/Users/user/Desktop/All_Projects/teamlink-enterprise/backend';
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env') });
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const { PrismaClient } = require(path.join(BACK, 'node_modules/@prisma/client'));
const prisma = new PrismaClient({ datasources: { db: { url: TLT.DATABASE_URL } } });
const tokenFor = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '60m' });
async function call(id, method, url, body) {
  for (let i = 0; i < 20; i += 1) {
    try {
      const res = await fetch(`${TLT.API}${url}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenFor(id)}` }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
      return { status: res.status, data };
    } catch (e) { await new Promise((r) => setTimeout(r, 2000)); }
  }
  throw new Error('sandbox API not answering');
}
let fails = 0;
function check(name, ok, extra) { if (!ok) fails += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== undefined ? `  ${typeof extra === 'string' ? extra : JSON.stringify(extra).slice(0, 400)}` : ''}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
module.exports = { TLT, prisma, call, check, fails: () => fails, sleep, tokenFor };
