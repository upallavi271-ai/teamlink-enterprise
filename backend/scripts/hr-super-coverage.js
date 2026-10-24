#!/usr/bin/env node
/* eslint-disable no-console */
// ---------------------------------------------------------------------------
// HR SENSITIVE ALERT COVERAGE REPORT (founder, 2026-10-14). Read-only: reads the route files, writes nothing.
//   node scripts/hr-super-coverage.js [--list]
// For every route (method + full path, found by reading index.js mounts and routes/*.js) it asks the same classifier
// the live watcher uses (utils/hrSensitiveAlert.js) what the route is:
//   delete  : HTTP DELETE or a /delete /remove /purge ... path          -> covered by the PATH rule
//   import  : /import /bulk /upload ... path                            -> covered by the PATH rule
//   export  : /export /download /.xlsx ... path                         -> covered by the PATH rule
//   file    : the handler writes a file (xlsx / csv / pdf / zip / attachment) but the path says nothing
//             -> covered by the RESPONSE rule (the watcher reads Content-Type / Content-Disposition / X-Export-Rows)
//   salary  : salary structure writes                                    -> covered (edited salary structure alert)
//   review  : the handler reads an uploaded file or deletes rows but neither rule can see it -> listed, please look
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '..', 'src');
const A = require('../src/utils/hrSensitiveAlert');

const index = fs.readFileSync(path.join(SRC, 'index.js'), 'utf8');
const vars = {};
for (const m of index.matchAll(/const\s+(\w+)\s*=\s*require\('\.\/routes\/([\w]+)'\)/g)) vars[m[1]] = m[2];
const mounts = [];
for (const m of index.matchAll(/app\.use\(\s*'(\/api[^']*)'\s*,\s*(?:[\w.]+\s*,\s*)*(?:require\('\.\/routes\/(\w+)'\)(?:\.\w+)?|(\w+))\s*\)/g)) {
  const file = m[2] || vars[m[3]];
  if (file) mounts.push({ prefix: m[1], file });
}
// routers built by a factory (employeeRecordRouter('KT')) are mounted from routes/employeeRecords.js
for (const m of index.matchAll(/app\.use\(\s*'(\/api[^']*)'\s*,\s*employeeRecordRouter\(/g)) mounts.push({ prefix: m[1], file: 'employeeRecords' });

const FILE_WRITE = /spreadsheetml|text\/csv|application\/pdf|application\/zip|Content-Disposition|res\.download|\.attachment\(|toXlsx|sendTable|sendBook|exportKit/;
const UPLOAD_READ = /rawUpload|multer|upload\.(single|array)|req\.files?\b|express\.raw|parseUpload|readImportRequest/;
const DELETE_CALL = /\.(delete|deleteMany)\(/;

const rows = [];
for (const { prefix, file } of mounts) {
  const fp = path.join(SRC, 'routes', `${file}.js`);
  if (!fs.existsSync(fp)) continue;
  const text = fs.readFileSync(fp, 'utf8');
  const re = /router\.(get|post|put|patch|delete)\(\s*(['`])([^'`]*)\2/g;
  const hits = [];
  let m;
  while ((m = re.exec(text))) hits.push({ method: m[1].toUpperCase(), p: m[3], at: m.index });
  hits.forEach((h, i) => {
    const body = text.slice(h.at, i + 1 < hits.length ? hits[i + 1].at : text.length);
    const full = `${prefix.replace(/^\/api/, '')}${h.p === '/' ? '' : h.p}` || '/';
    const reg = A.registryHit(h.method, full);
    let kind = reg ? reg.kind : A.classify({ method: h.method, path: full, contentType: '', disposition: '', multipart: false, status: 200 });
    let how = kind ? (reg ? 'registry' : 'path rule') : null;
    if (!kind && h.method !== 'GET' && /^\/payroll\/(structure|ctc-settings)/.test(full)) { kind = 'salary'; how = 'path rule'; }
    if (!kind && FILE_WRITE.test(body) && /(attachment|spreadsheetml|text\/csv|sendTable|sendBook|toXlsx|res\.download)/.test(body)) { kind = 'file'; how = 'response rule'; }
    if (!kind && h.method !== 'GET' && UPLOAD_READ.test(body) && /(import|bulk|rows|history|sync)/i.test(body.slice(0, 1200))) { kind = 'review'; how = 'multipart rule if the path is not a single attachment'; }
    if (!kind && h.method !== 'GET' && DELETE_CALL.test(body) && !/DELETE/.test(h.method)) { kind = 'review'; how = 'handler deletes rows but is not a DELETE / delete path'; }
    rows.push({ module: A.moduleOf(full), method: h.method, path: full, kind, how, file });
  });
}

const by = {};
rows.forEach((r) => {
  by[r.module] = by[r.module] || { delete: 0, import: 0, export: 0, file: 0, salary: 0, review: 0, total: 0 };
  by[r.module].total += 1;
  if (r.kind) by[r.module][r.kind] += 1;
});
console.log(`Routes scanned: ${rows.length} (mounted routers: ${mounts.length})`);
console.log('\nModule | delete | import | export | file-by-response | salary | to review | all routes');
Object.keys(by).sort().forEach((k) => {
  const x = by[k];
  console.log(`${k} | ${x.delete} | ${x.import} | ${x.export} | ${x.file} | ${x.salary} | ${x.review} | ${x.total}`);
});
const tot = (k) => rows.filter((r) => r.kind === k).length;
console.log(`\nTOTAL covered by path rule / registry: delete ${tot('delete')}, import ${tot('import')}, export ${tot('export')}, salary ${tot('salary')}; by response headers: ${tot('file')}; still to review: ${tot('review')}`);
if (process.argv.includes('--list')) {
  rows.filter((r) => r.kind).forEach((r) => console.log(`${r.kind.padEnd(7)} ${r.method.padEnd(6)} ${r.path}  [${r.how}] (${r.file}.js)`));
} else {
  console.log('\nTO REVIEW (a handler that reads an upload / deletes rows without a telling path):');
  rows.filter((r) => r.kind === 'review').forEach((r) => console.log(`  ${r.method.padEnd(6)} ${r.path}  [${r.how}] (${r.file}.js)`));
}
