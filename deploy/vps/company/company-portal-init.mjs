// ---------------------------------------------------------------------------
// MAKE A NEW COMPANY'S JOB PORTAL ITS OWN (docs/second-company.md section 11).     Run by company-portal-install.sh, with the PORTAL STOPPED.
//
//   cd <the company's job-portal-app/job_portal-main>
//   DEV_DB_DIR=<the company's portal database folder> NISH_COMPANY_NAME="..." NISH_ADMINS='[{"name":"..","email":".."}]' \
//     node --input-type=module < company-portal-init.mjs
//
// A brand-new Job Portal database is not empty. On its first start the portal's own setup writes:
//   * a company called "TeamLink Consultants" (migration), also named in the AI-calling settings and two publishing labels;
//   * two demo logins, recruiter@teamlink.com and bde@teamlink.com ("Dev Recruiter", "Priya Nair"), when the users table is empty.
// None of that belongs to another company. This script, run once on the freshly created database:
//   1. renames the company, the AI-calling company name and the two "TeamLink ..." publishing labels to the new company's name;
//   2. removes exactly the two demo logins and their two profile rows (nothing else; it refuses if they look changed);
//   3. gives the company's own Admin(s) a portal admin login (random password nobody types: they come in from the app), the way the portal's
//      own TeamLink sync does (embed/teamlink-integration.mjs admins/ensure). That is also what stops the portal's first-start code from
//      writing the demo logins AGAIN on a later start, because it only does that when the users table is empty.
// It never touches a row it did not expect and prints names of tables only, never a password.
// ---------------------------------------------------------------------------
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const dir = process.env.DEV_DB_DIR;
const company = String(process.env.NISH_COMPANY_NAME || '').trim();
let admins = [];
try { admins = JSON.parse(process.env.NISH_ADMINS || '[]'); } catch { admins = []; }
if (!dir || !company) { console.error('[portal-init] DEV_DB_DIR and NISH_COMPANY_NAME are required.'); process.exit(2); }
admins = admins.filter((a) => a && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(a.email || '')) && String(a.name || '').trim().length >= 2);
if (!admins.length) { console.error('[portal-init] at least one admin (name + email) is required, so the portal never starts with an empty users table.'); process.exit(2); }

const { PGlite } = await import('@electric-sql/pglite');
const { hashPassword } = await import(pathToFileURL(join(process.cwd(), 'api', 'src', 'auth.js')).href);
const db = await new PGlite(dir);

const DEMO_USERS = ['recruiter@teamlink.com', 'bde@teamlink.com'];
let step = 'start';
try {
  await db.exec('begin');

  step = 'rename the company';
  const co = await db.query("update companies set name = $1 where id = 'tmlink' and name = 'TeamLink Consultants' returning id", [company]);
  console.log(`[portal-init] company renamed: ${co.rows.length} row(s)`);
  const ai = await db.query("update ai_call_settings set company_name = $1 where company_name = 'TeamLink Consultants' returning id", [company]).catch(() => ({ rows: [] }));
  console.log(`[portal-init] AI-calling company name: ${ai.rows.length} row(s)`);
  const lab = await db.query(
    `update publishing_destinations set label = case key when 'TEAMLINK_PORTAL' then $1 when 'TEAMLINK_WEBSITE' then $2 else label end
       where key in ('TEAMLINK_PORTAL','TEAMLINK_WEBSITE') and label in ('TeamLink Job Portal','TeamLink Website') returning key`,
    [`${company} Job Portal`, `${company} Website`]).catch(() => ({ rows: [] }));
  console.log(`[portal-init] publishing labels: ${lab.rows.length} row(s)`);

  step = 'remove the two demo logins';
  const demoUsers = (await db.query('select id, email, role from users where lower(email) = any($1)', [DEMO_USERS])).rows;
  const rec = (await db.query("select id, name, email from recruiters where id = 'rec1'")).rows;
  const bde = (await db.query("select id, name, email from bde_users where id = 'bde1'")).rows;
  const total = (await db.query('select count(*)::int n from users')).rows[0].n;
  if (demoUsers.length || rec.length || bde.length) {
    // refuse anything that is not exactly the portal's own first-start rows
    if (rec.length && !(rec[0].name === 'Dev Recruiter' && rec[0].email === 'recruiter@teamlink.com')) throw new Error('recruiter rec1 is not the demo row: not touching it');
    if (bde.length && !(bde[0].name === 'Priya Nair' && bde[0].email === 'bde@teamlink.com')) throw new Error('bde bde1 is not the demo row: not touching it');
    if (total > demoUsers.length) throw new Error(`the portal has ${total} logins, more than the demo ones (${demoUsers.length}): this is not a fresh portal, nothing removed`);
    await db.query("delete from recruiters where id = 'rec1'");
    await db.query("delete from bde_users where id = 'bde1'");
    await db.query('delete from users where lower(email) = any($1)', [DEMO_USERS]);
    console.log(`[portal-init] removed ${demoUsers.length} demo login(s), ${rec.length} demo recruiter profile(s), ${bde.length} demo BDE profile(s)`);
  } else console.log('[portal-init] no demo rows found (already clean)');

  step = 'make the company\'s own admin login(s)';
  for (const a of admins) {
    const email = String(a.email).trim().toLowerCase();
    const name = String(a.name).trim().slice(0, 120);
    const u = (await db.query('select id, role from users where lower(email) = $1', [email])).rows[0];
    if (u) { console.log(`[portal-init] admin ${u.role === 'admin' ? 'already exists' : 'email is used by another role: skipped'}`); continue; }
    const hash = await hashPassword(randomBytes(24).toString('base64url'));
    const id = (await db.query("insert into users (email, password_hash, role, status) values ($1, $2, 'admin', 'active') returning id", [email, hash])).rows[0].id;
    const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
    await db.query("insert into admins (id, user_id, name, email, title, initials) values ($1, $2, $3, $4, 'Administrator', $5)",
      [`tl_a_${randomBytes(6).toString('hex')}`, id, name, email, initials || null]);
    console.log('[portal-init] admin login made');
  }

  step = 'check';
  const left = (await db.query('select email from users order by 1')).rows.map((r) => r.email);
  if (!left.length) throw new Error('the users table would be empty: the portal would write its demo logins again');
  if (left.some((m) => DEMO_USERS.includes(String(m).toLowerCase()))) throw new Error('a demo login is still there');
  await db.exec('commit');
  console.log(`[portal-init] done. logins now: ${left.length}; companies: ${(await db.query('select name from companies')).rows.map((r) => r.name).join(', ')}`);
  await db.exec('checkpoint').catch(() => {});
  await db.close();
  process.exit(0);
} catch (err) {
  await db.exec('rollback').catch(() => {});
  console.error(`[portal-init] FAILED at "${step}", nothing changed: ${err.message}`);
  await db.close().catch(() => {});
  process.exit(3);
}
