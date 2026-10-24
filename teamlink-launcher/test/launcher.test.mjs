// Launcher test: a stand-in "job board" page on this PC (never a real site), the Launcher in test mode, real Chrome (headless).
//   node test/launcher.test.mjs
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.TL_LAUNCHER_TEST = '1';
process.env.TL_LAUNCHER_PORT = '47899';
process.env.TL_LAUNCHER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-launcher-'));

const PAGE = `<!doctype html><html><body>
<h2>Post a job</h2>
<input id="q" placeholder="Search jobs">
<label>Company name <input name="company" value=""></label>
<label for="t">Job Title *</label><input id="t" type="text">
<div><span>Job location</span><input type="text" name="loc"></div>
<label>Experience (years) <input id="exp" type="text"></label>
<label>Key skills <input id="skills" type="text"></label>
<label>Job Description <textarea></textarea></label>
<label>Salary <input id="sal" type="text" value="already 5 LPA"></label>
<label>Employment type <select><option value="">Select</option><option value="ft">Full time</option><option value="pt">Part time</option></select></label>
<label>Email <input type="email"></label><label>Password <input type="password"></label>
<button>Post</button></body></html>`;

let pass = 0; let fail = 0;
const ok = (n, c, d) => { if (c) pass += 1; else fail += 1; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${!c && d ? `  -> ${JSON.stringify(d).slice(0, 300)}` : ''}`); };

const stub = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(PAGE); });
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
process.env.TL_LAUNCHER_TEST_URL = `http://127.0.0.1:${stub.address().port}/post`;

const L = await import('../launcher.mjs');
const server = L.createServer();
await new Promise((r) => server.listen(L.PORT, '127.0.0.1', r));
const base = `http://127.0.0.1:${L.PORT}`;
const call = async (method, p, body, headers = {}) => {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
};

const fields = [
  { label: 'Job title', value: 'Staff Nurse' }, { label: 'Location', value: 'Hyderabad' }, { label: 'Experience', value: '2-4 yrs' }, { label: 'Skills', value: 'ICU, ventilator care' },
  { label: 'Job description', value: 'We need a staff nurse for our ICU. '.repeat(8) }, { label: 'Salary range', value: '4 LPA' }, { label: 'Employment type', value: 'Full time' }, { label: 'Openings', value: '3' },
];
try {
  let r = await call('GET', '/ping');
  ok('L1 ping answers with the version and the boards', r.status === 200 && r.body.ok && r.body.boards.includes('naukri') && r.body.boards.includes('linkedin'), r.body);
  r = await call('GET', '/ping', null, { Origin: 'https://evil.example' });
  ok('L2 a web page from another address is refused (403)', r.status === 403, [r.status, r.body]);
  r = await call('GET', '/ping', null, { Origin: 'http://localhost:5183' });
  ok('L3 TeamLink\'s own address is allowed, with the private-network header', r.status === 200 && r.headers.get('access-control-allow-origin') === 'http://localhost:5183' && r.headers.get('access-control-allow-private-network') === 'true');
  r = await call('POST', '/open', { board: 'nonsense', fields });
  ok('L4 an unknown board is refused (400)', r.status === 400, r.body);
  r = await call('POST', '/open', { board: 'naukri', fields });
  ok('L5 open: the board page opens in Chrome and the boxes are remembered', r.status === 200 && r.body.ok && r.body.boxes === 8, r.body);
  r = await call('POST', '/_test/fill', { board: 'naukri' });
  ok('L6 fill: title, location, experience, skills, description, employment type are filled', r.body && ['Job title', 'Location', 'Experience', 'Skills', 'Job description', 'Employment type'].every((x) => r.body.filled.includes(x)), r.body);
  ok('L7 salary box that already had text is NOT overwritten, and Openings (no box) is reported as left', r.body && !r.body.filled.includes('Salary range') && r.body.left.includes('Openings') && r.body.left.includes('Salary range'), r.body);
  const page = L.__sessions.get('naukri').context.pages()[0];
  const v = await page.evaluate(() => ({
    title: document.getElementById('t').value, loc: document.querySelector('[name=loc]').value, search: document.getElementById('q').value,
    company: document.querySelector('[name=company]').value, email: document.querySelector('[type=email]').value, pass: document.querySelector('[type=password]').value,
    salary: document.getElementById('sal').value, exp: document.getElementById('exp').value, skills: document.getElementById('skills').value, area: document.querySelector('textarea').value.slice(0, 30), sel: document.querySelector('select').value,
  }));
  ok('L8 the right text went into the right boxes', v.title === 'Staff Nurse' && v.loc === 'Hyderabad' && v.exp === '2-4 yrs' && v.skills === 'ICU, ventilator care' && /^We need a staff nurse/.test(v.area) && v.sel === 'ft', v);
  ok('L9 search, company, e-mail and password boxes were never touched', v.search === '' && v.company === '' && v.email === '' && v.pass === '', v);
  ok('L10 salary kept what the person had typed', v.salary === 'already 5 LPA', v);
  const btn = await page.evaluate(() => !!document.getElementById('__tl_launcher') && /Fill this form/.test(document.getElementById('__tl_go').textContent));
  ok('L11 the green "Fill this form from TeamLink" button is on the page', btn);
  r = await call('POST', '/_test/fill', { board: 'naukri' });
  ok('L12 pressing it again fills nothing more (boxes are no longer empty)', r.body && r.body.filled.length === 0, r.body);
  ok('L13 the page was never submitted (still the same page, Post not pressed)', (await page.evaluate(() => location.pathname)) === '/post');
} finally {
  await L.closeAll();
  server.close(); stub.close();
  try { fs.rmSync(process.env.TL_LAUNCHER_HOME, { recursive: true, force: true }); } catch { /* the OS cleans temp */ }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
