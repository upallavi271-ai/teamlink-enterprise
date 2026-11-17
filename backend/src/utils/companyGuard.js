// ---------------------------------------------------------------------------
// SEPARATE COMPANY GUARD (2026-11-16).
//
// A second company (for example NISHTECHNOLOGIES INDIA PVT LTD) runs as its OWN copy of this application: its own folder, its own
// process and port, its own SQLite database and its own uploaded files (docs/second-company.md). Nothing is shared with TeamLink
// Enterprises, so nothing of TeamLink can be seen from there.
//
// The one way that could still go wrong is a wiring mistake: the second company's server pointed at TeamLink's database file (or
// TeamLink's server pointed at the other company's). This guard makes that impossible to do quietly.
//
//   COMPANY_KEY=nish   (in that copy's .env only)  ->  the server answers NOTHING (503) until it has read the row
//                       AppSetting 'company.key' = {"key":"nish"} from ITS database, and the process STOPS if the row is
//                       missing or different. TeamLink's database has no such row, so a server started with COMPANY_KEY against
//                       TeamLink's database refuses to run.
//   COMPANY_KEY not set (TeamLink, and every PC)  ->  this file does nothing at all: no query, no new behaviour.
//
// scripts/company-init.js writes the row when it creates the company's database.
// ---------------------------------------------------------------------------
const KEY_ROW = 'company.key';

// A COMPANY COPY KEEPS ITS OWN HOME FOLDER, whatever starts it (found 2026-11-17). Every default data folder of this program hangs under the Linux
// user's home folder (~/.teamlink-uploads, ~/.teamlink-company-bridge ...), and TeamLink uses /root. "pm2 restart --update-env" copies the CALLER's
// environment over the process's, so a restart from a root shell silently gave the company's server HOME=/root: it could read TeamLink's key folder.
// COMPANY_HOME (this copy's .env, written by company-install.sh) is therefore applied here, before anything looks at the home folder.
const homeWas = (() => {
  const want = String(process.env.COMPANY_KEY || '').trim() ? String(process.env.COMPANY_HOME || '').trim() : '';
  if (!want || process.env.HOME === want) return null;
  const was = process.env.HOME || '';
  process.env.HOME = want;
  if (process.platform === 'win32') process.env.USERPROFILE = want;
  return was;
})();

const wanted = () => String(process.env.COMPANY_KEY || '').trim().toLowerCase();
let state = wanted() ? 'checking' : 'off'; // off | checking | ok | bad
let started = false;

function parse(v) {
  try { const o = JSON.parse(v); return o && typeof o === 'object' ? o : null; } catch { return null; }
}

// Reads the row and decides. Returns { ok, found, wanted } (also used by scripts/company-check.js and the tests).
async function verify(prisma) {
  const want = wanted();
  if (!want) return { ok: true, found: null, wanted: '' };
  const row = await prisma.appSetting.findUnique({ where: { key: KEY_ROW } });
  const found = row ? String((parse(row.value) || {}).key || '').trim().toLowerCase() : null;
  return { ok: found === want, found, wanted: want };
}

// Called once, early, from index.js. Never throws; a wrong database stops the process with a plain sentence.
function start() {
  if (started || state === 'off') return;
  started = true;
  if (homeWas !== null) console.log(`[company] the process was started with HOME=${homeWas || '(none)'}; using this company's own home folder (COMPANY_HOME) instead.`); // eslint-disable-line no-console
  const prisma = require('../db'); // eslint-disable-line global-require
  verify(prisma).then((r) => {
    if (r.ok) { state = 'ok'; console.log(`[company] this server belongs to company "${r.wanted}" and its database says the same.`); return; } // eslint-disable-line no-console
    state = 'bad';
    console.error(`[company] STOPPED: this server is set up for company "${r.wanted}" (COMPANY_KEY) but its database says ${r.found ? `"${r.found}"` : 'nothing (it is not that company\'s database)'}. Check DATABASE_URL in this copy's .env.`); // eslint-disable-line no-console
    process.exit(78);
  }).catch((err) => {
    state = 'bad';
    console.error(`[company] STOPPED: could not read the company row from the database (${err.message.split('\n')[0]}).`); // eslint-disable-line no-console
    process.exit(78);
  });
}

// Express middleware: until the database has been checked, every request is told to wait (503); a wrong database never serves one.
function middleware(req, res, next) {
  if (state === 'off' || state === 'ok') return next();
  return res.status(503).json({ error: 'Starting up. Please try again in a moment.' });
}

module.exports = { start, middleware, verify, KEY_ROW, wanted, status: () => state };
