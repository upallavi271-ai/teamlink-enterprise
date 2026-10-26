'use strict';
// report.js : turns a delta + the engine result into the plain-English report the founder reads.

const { showValue } = require('./lib');

const NOISY = /^(AppSetting|AuditLog|AssetAuditLog|ApplicationStageEvent|AttendanceHistory|AttendancePunch|ApprovalStep)$/;

function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }
function rpad(s, n) { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; }

function counts(out) {
  const c = { added: 0, changed: 0, already: 0, conflicts: 0, blocked: 0, refused: 0, rolledback: 0 };
  for (const r of out.results) {
    if (r.status === 'applied') { if (r.k === 'I') c.added++; else c.changed++; }
    else if (r.status === 'already') c.already++;
    else if (r.status === 'conflict') c.conflicts++;
    else if (r.status === 'blocked') c.blocked++;
    else if (r.status === 'refused') c.refused++;
    else if (r.status === 'rolledback') c.rolledback++;
  }
  return c;
}

function format(delta, out, mode, extra) {
  extra = extra || {};
  const apply = mode === 'apply';
  const c = counts(out);
  const L = [];
  const say = (s) => L.push(s === undefined ? '' : s);
  say('==============================================================');
  say(apply ? '  CHANGES-ONLY PUSH : WHAT WAS DONE ON THE LIVE SITE' : '  CHANGES-ONLY PUSH : REPORT  (nothing has been changed yet)');
  say('==============================================================');
  say('Made on ' + delta.createdAt.replace('T', ' ').slice(0, 19) + ' (UTC). Compared: your localhost database against the last matching copy.');
  say('');
  say('IN SHORT');
  say('  ' + rpad(c.added, 6) + '  new rows ' + (apply ? 'ADDED' : 'will be ADDED') + ' to the live site');
  say('  ' + rpad(c.changed, 6) + '  changed rows ' + (apply ? 'UPDATED' : 'will be UPDATED') + ' (only the changed boxes, nothing else in the row)');
  say('  ' + rpad(c.already, 6) + '  already on the live site (nothing to do)');
  say('  ' + rpad(c.conflicts, 6) + '  CONFLICTS - left alone, listed below, come back next time');
  if (c.blocked) say('  ' + rpad(c.blocked, 6) + '  waiting because they depend on a row that had a conflict');
  if (c.refused) say('  ' + rpad(c.refused, 6) + '  not done because the table is different on the two sides (see NOTES)');
  if (c.rolledback) say('  ' + rpad(c.rolledback, 6) + '  ROLLED BACK - the safety check found a broken link, so NOTHING was changed');
  say('  ' + rpad(delta.deletes.length, 6) + '  rows you deleted locally - NOT deleted on the live site (only added/changed things travel)');
  const exTot = Object.values(delta.excluded.tables).reduce((a, t) => a + t.new + t.changed, 0)
    + Object.values(delta.excluded.rows).reduce((a, n) => a + n, 0) + delta.excluded.appSettings.length + delta.excluded.dependsOnExcluded;
  say('  ' + rpad(exTot, 6) + '  changes NOT pushed on purpose (secrets, queues, logins, test data...) - see below');
  say('');

  // per table
  const tabs = Object.keys(out.perTable).sort();
  if (tabs.length) {
    say('PER TABLE');
    say('  ' + pad('Table', 28) + rpad('New', 7) + rpad('Changed', 9) + rpad('Already', 9) + rpad('Conflict', 10) + rpad('Waiting', 9));
    for (const t of tabs) {
      const p = out.perTable[t];
      const nw = apply ? p.newAdded : p.newAdded; const ch = p.changedAdded;
      say('  ' + pad(t, 28) + rpad(nw, 7) + rpad(ch, 9) + rpad(p.newAlready + p.changedAlready, 9) + rpad(p.newConflict + p.changedConflict + p.refused, 10) + rpad(p.blocked + p.rolledback, 9));
    }
    say('');
  }

  // first 20 readable changes
  const good = out.results.filter((r) => r.status === 'applied' || r.status === 'rolledback');
  const pri = good.filter((r) => !NOISY.test(r.table)).concat(good.filter((r) => NOISY.test(r.table)));
  if (pri.length) {
    say('FIRST ' + Math.min(20, pri.length) + ' CHANGES' + (pri.length > 20 ? ' (of ' + pri.length + ')' : ''));
    for (const r of pri.slice(0, 20)) {
      if (r.k === 'I') say('  + NEW  ' + r.table + (r.label ? ': ' + r.label : ''));
      else {
        const cols = (r.detail && r.detail.columns) || [];
        say('  ~ EDIT ' + r.table + (r.label ? ': ' + r.label : '') + ' -> ' + cols.slice(0, 3).map((x) => x.column + ' ' + x.baseline + ' => ' + x.local).join('; ') + (cols.length > 3 ? '; +' + (cols.length - 3) + ' more' : ''));
      }
    }
    say('');
  }

  // conflicts
  const conf = out.results.filter((r) => r.status === 'conflict');
  if (conf.length) {
    say('CONFLICTS (' + conf.length + ') - nobody lost anything: these were skipped; decide by hand');
    for (const r of conf) {
      say('  * ' + r.table + (r.label ? ': ' + r.label : '') + '  [' + (r.k === 'I' ? 'new row' : 'edited row') + ']');
      say('      why: ' + r.reason);
      const cols = (r.detail && r.detail.columns) || [];
      for (const x of cols) {
        if (x.baseline !== undefined) say('      ' + x.column + ':  was ' + x.baseline + '  | you changed it to ' + x.local + '  | live site has ' + x.target);
        else say('      ' + x.column + ':  your copy ' + x.local + '  | live site has ' + x.target);
      }
    }
    say('');
  }
  const blk = out.results.filter((r) => r.status === 'blocked');
  if (blk.length) {
    say('WAITING (' + blk.length + ') - depend on a conflicted row');
    for (const r of blk.slice(0, 20)) say('  - ' + r.table + (r.label ? ': ' + r.label : '') + ' : ' + r.reason);
    if (blk.length > 20) say('  ... and ' + (blk.length - 20) + ' more');
    say('');
  }
  if (out.rolledBack) {
    say('SAFETY STOP: the broken-link check found ' + (out.fkNewCount || out.fkNew.length) + ' new broken link(s), e.g.:');
    for (const f of out.fkNew.slice(0, 10)) say('  - table ' + f.table + ' row ' + f.rowid + ' points to a missing row in ' + f.parent);
    say('  NOTHING was changed in the database this step was applied to (the other side is reported separately).');
    say('');
  }

  // notes
  const notes = [];
  for (const [t, why] of Object.entries(out.refused)) notes.push('Table ' + t + ' refused: ' + why);
  for (const s of delta.schemaNotes) notes.push(s);
  for (const [t, cols] of Object.entries(out.dropped || {})) notes.push('Table ' + t + ': columns not on the live site were left out: ' + cols.join(', '));
  if (delta.noPrimaryKey.length) notes.push('Tables with no primary key are skipped: ' + delta.noPrimaryKey.join(', '));
  if (delta.newTablesLocal.length) notes.push('Tables that exist only locally (all rows are new): ' + delta.newTablesLocal.join(', '));
  if (delta.migrations && delta.migrations.localNotInBaseline.length) notes.push('Local has ' + delta.migrations.localNotInBaseline.length + ' database update(s) that the baseline does not know. Values in the NEW columns of old rows are not compared.');
  if (notes.length) { say('NOTES'); notes.forEach((n) => say('  - ' + n)); say(''); }

  // deletes
  if (delta.deletes.length) {
    say('DELETED LOCALLY - NOT applied (' + delta.deletes.length + ')');
    const by = {};
    for (const d of delta.deletes) (by[d.table] = by[d.table] || []).push(d);
    for (const t of Object.keys(by).sort()) say('  ' + pad(t, 28) + by[t].length + (by[t][0].label ? '   e.g. ' + by[t].slice(0, 3).map((x) => x.label || JSON.stringify(x.pk)).join(', ') : ''));
    say('');
  }

  // excluded
  say('NOT PUSHED ON PURPOSE (never travels, edit exclusions.json to change)');
  const exT = Object.entries(delta.excluded.tables).filter(([t]) => t !== '_prisma_migrations');
  if (exT.length) {
    for (const [t, v] of exT) say('  table ' + pad(t, 24) + 'new ' + rpad(v.new, 5) + '  changed ' + rpad(v.changed, 5) + '  deleted ' + rpad(v.deleted, 5) + '  (' + v.reason + ')');
  } else say('  (no differing rows in the excluded tables)');
  for (const [k, n] of Object.entries(delta.excluded.rows)) say('  rows ' + pad(k, 50) + n);
  if (delta.excluded.dependsOnExcluded) say('  rows that point to a row that does not travel: ' + delta.excluded.dependsOnExcluded);
  const apps = delta.excluded.appSettings;
  if (apps.length) {
    say('  AppSetting keys that differ but are NOT on the allow list (' + apps.length + ') - tell me a key to opt it in:');
    for (const a of apps.slice(0, 40)) say('      ' + a.key + '  [' + a.state + ']');
    if (apps.length > 40) say('      ... and ' + (apps.length - 40) + ' more');
  }
  const cs = delta.configSummary;
  say('  Table patterns never pushed: ' + (cs.excludedNamePatterns || []).map((p) => p.pattern).join('  ') + '  (except ' + Object.keys(cs.alwaysPushTables || {}).join(', ') + ')');
  say('  Excluded tables (' + Object.keys(cs.excludedTables).length + '): ' + Object.keys(cs.excludedTables).join(', '));
  say('  Login/one-time-code columns never compared or written: ' + Object.entries(cs.ignoreColumns || {}).map(([t, c]) => t + '.' + c.join('/')).join('; '));
  say('  Test data (text containing ' + cs.testRowPattern + ') never travels.');
  say('  AppSetting allow list: ' + cs.appSettingAllowPrefixes.map((p) => p + '*').concat(cs.appSettingAllowExact).join(', '));
  say('');

  // files
  const fileRows = extra.fileRows !== undefined ? extra.fileRows : countFileRows(delta, out);
  say('FILES');
  say('  Uploaded files (resumes, documents) are NOT copied by this tool.');
  if (extra.missingFiles !== undefined) {
    say('  ' + extra.missingFiles + ' of ' + fileRows + ' pushed document rows point to files that are NOT on the live site.');
    if (extra.missingList && extra.missingList.length) extra.missingList.slice(0, 10).forEach((m) => say('      - ' + m));
  } else {
    say('  ' + fileRows + ' document row(s) in this push point to files; the files must be copied separately if they are not on the live site.');
  }
  say('');
  if (extra.footer) extra.footer.forEach(say);
  return L.join('\n');
}

function countFileRows(delta, out) {
  let n = 0;
  const ok = new Set(out.results.filter((r) => r.status === 'applied' || r.status === 'already' || r.status === 'rolledback').map((r) => r.id));
  for (const f of delta.fileReferences || []) {
    const T = delta.tables[f.table]; if (!T) continue;
    for (const op of T.ops) {
      if (!ok.has(op.id)) continue;
      if (f.columns.some((c) => op.row[c] !== null && op.row[c] !== undefined && op.row[c] !== '')) n++;
    }
  }
  return n;
}

module.exports = { format, counts, countFileRows };
