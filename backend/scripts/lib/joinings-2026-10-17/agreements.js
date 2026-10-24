// ---------------------------------------------------------------------------
// JOININGS IMPORT 2026-10-17 - PHASE A: OFFICIAL CLIENT NAMES + SIGNED AGREEMENT FILES.
//
//  * RENAME: a client whose signed agreement prints a different name gets the printed (official) name as Client.name (and
//    Client.legalName). The old name is kept as a ClientAlias (source "rename"), so searches, imports and old sheets still find it.
//    Only high-confidence renames are applied (pack status RENAME). A rename is skipped (and listed) when the client changed since
//    it was checked, or when another client already has that very name (a duplicate - to be merged, not made twin).
//  * FILES: every matched file becomes one ClientDocument (kind AGREEMENT_SIGNED) + one AppSetting 'agrsigned.<id>' with its details,
//    through the file store the app already uses (a copy with a random 32-hex name in the uploads folder).
//    Identical content (same sha256) twice for one client is stored once; each skipped copy is listed with the twin that was kept.
//    An agreement whose client is not in the app creates that client (exact printed name, Active, department from the form sheet).
//    The file type is decided from the first bytes. Nothing is thrown away: a file with no client stays on disk and is listed.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fullKey, nkey, sp } = require('./names');
const { newId } = require('./ledger');

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dmy = (iso) => (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${Number(iso.slice(8, 10))} ${MON[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}` : null);
const MIME = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.jfif': 'image/jpeg', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
const STORE_EXT = { '.pdf': 'pdf', '.png': 'png', '.jpg': 'jpg', '.jpeg': 'jpg', '.jfif': 'jpg', '.docx': 'docx' };
const magicOk = (ext, head) => {
  if (ext === '.pdf') return head.slice(0, 4).toString('latin1') === '%PDF';
  if (ext === '.png') return head[0] === 0x89 && head.slice(1, 4).toString('latin1') === 'PNG';
  if (['.jpg', '.jpeg', '.jfif'].includes(ext)) return head[0] === 0xff && head[1] === 0xd8;
  if (ext === '.docx') return head.slice(0, 2).toString('latin1') === 'PK';
  return false;
};

function planRenames({ S, L, pack, importedBy }) {
  const rows = [];
  const pairs = []; // two client rows that now carry the same printed name (kept separate)
  const aliasKeys = new Set(S.aliases.map((a) => a.aliasKey));
  const packIds = new Map(pack.renames.map((r) => [r.clientId, r]));
  const done = new Set();
  const rename = (c, official, old) => {
    L.update('client', c.id, { name: official, legalName: official }, { name: c.name, legalName: c.legalName });
    const aliasKey = fullKey(old);
    let alias;
    if (aliasKey && !aliasKeys.has(aliasKey)) {
      L.create('clientAlias', { clientId: c.id, alias: old, aliasKey, source: 'rename' });
      aliasKeys.add(aliasKey);
      S.aliases.push({ clientId: c.id, alias: old, aliasKey, source: 'rename' });
      alias = 'old name kept as alias';
    } else alias = aliasKey ? 'old name already a search name of this client' : 'no alias key';
    c.name = official; c.legalName = official;
    done.add(c.id);
    return alias;
  };
  for (const r of pack.renames) {
    const row = {
      clientId: r.clientId, current: r.current, official: r.official, status: r.status, applied: false, reason: r.why || '', dateUsed: r.dateUsed || '', pdfUsed: r.pdfUsed || '', pageUsed: r.pageUsed || '',
      otherPrintedNames: (r.otherPrintedNames || []).join(' ; '), evidence: r.evidence.map((e) => `${e.file} (${e.folder.replace(/ \(File responses\)/, '')}) page ${e.page || 1} printed "${e.printed}" ${e.date || ''}`.trim()),
    };
    rows.push(row);
    if (r.status === 'UNDECIDABLE') continue;
    const c = S.clientById.get(r.clientId);
    if (!c) { row.reason = 'client not found any more'; row.status = 'SKIPPED'; continue; }
    if (sp(c.name) === sp(r.official)) { row.status = r.status === 'RENAME' ? 'ALREADY RENAMED' : 'ALREADY OFFICIAL'; row.reason = r.status === 'RENAME' ? 'already renamed by an earlier run' : ''; }
    else if (sp(c.name) !== sp(r.current)) { row.reason = `the client is now called "${c.name}" - changed after it was checked`; row.status = 'SKIPPED'; continue; }
    else { row.alias = rename(c, r.official, c.name); row.applied = true; row.status = 'RENAMED'; }
    // another client row of the same college / hospital (same name once spelling marks are ignored): it gets the same printed name, stays a separate client
    const key = fullKey(r.official);
    const dept = (x) => x.ownerDepartment || null;
    S.clients.filter((o) => o.id !== c.id && !done.has(o.id) && fullKey(o.name) === key && (!dept(o) || !dept(c) || dept(o) === dept(c)) && !(packIds.get(o.id) && packIds.get(o.id).official && packIds.get(o.id).official !== r.official)).forEach((o) => {
      const old = o.name;
      const pair = { official: r.official, a: { id: c.id, oldName: r.current, city: c.location || '' }, b: { id: o.id, oldName: old, city: o.location || '' } };
      if (sp(old) !== sp(r.official)) {
        const alias = rename(o, r.official, old);
        rows.push({ clientId: o.id, current: old, official: r.official, status: 'RENAMED (second client row of the same name)', applied: true, reason: `same college as ${c.id}; kept as a separate client, not merged`, alias, dateUsed: row.dateUsed, pdfUsed: row.pdfUsed, pageUsed: row.pageUsed, otherPrintedNames: '', evidence: row.evidence });
      }
      pairs.push(pair);
    });
  }
  rows.pairs = pairs;
  return rows;
}

// What kind of file it really is: decided from the first bytes, not from the name (one ".docx" in the zip is really a PDF)
function sniff(head) {
  if (head.slice(0, 4).toString('latin1') === '%PDF') return { ext: 'pdf', ext2: '.pdf', mime: 'application/pdf' };
  if (head[0] === 0x89 && head.slice(1, 4).toString('latin1') === 'PNG') return { ext: 'png', ext2: '.png', mime: 'image/png' };
  if (head[0] === 0xff && head[1] === 0xd8) return { ext: 'jpg', ext2: '.jpg', mime: 'image/jpeg' };
  if (head.slice(0, 2).toString('latin1') === 'PK') return { ext: 'docx', ext2: '.docx', mime: MIME['.docx'] };
  return null;
}
// which of two identical files to keep: the Original signed folder first, then Vasu-Sir, then the plain confirmations; then the newest upload
const folderRank = (folder) => (/^Client Signed/i.test(folder) ? 0 : /^Vasu/i.test(folder) ? 1 : 2);
const better = (a, b) => {
  const ra = folderRank(a.folder); const rb = folderRank(b.folder);
  if (ra !== rb) return ra < rb;
  if ((a.uploaded || '') !== (b.uploaded || '')) return (a.uploaded || '') > (b.uploaded || '');
  const ca = /\(\d+\)/.test(a.name) ? 1 : 0; const cb = /\(\d+\)/.test(b.name) ? 1 : 0;
  if (ca !== cb) return ca < cb;
  return `${a.folder}/${a.name}` < `${b.folder}/${b.name}`;
};

function planFiles({ S, L, pack, zipDir, uploadsDir, importedBy, readFiles }) {
  const out = { attached: [], duplicates: [], unmatched: [], problems: [], fileOps: [], unmatchedOps: [], createdClients: [], reusedClients: [], sharedContent: [], fileRows: [] };
  const haveSha = new Set(); // clientId|sha already stored by an earlier run
  S.signedSettings.forEach((s) => { try { const j = JSON.parse(s.value); const id = s.key.slice('agrsigned.'.length); const d = S.signedDocs.find((x) => x.id === id); if (d && j.sha256) haveSha.add(`${d.clientId}|${j.sha256}`); } catch { /* ignore */ } });
  const keyOf = (f) => `${f.folder} / ${f.name}`;
  const fileRow = (f, client, action, how, extra = {}) => out.fileRows.push({ folder: f.folder.replace(/ \(File responses\)$/, ''), file: f.name, sha256: f.sha256, size: f.size, uploaded: f.uploaded, client: client ? client.name : '', clientId: client ? client.id : '', action, how: how || f.how || '', keptTwin: '', ...extra });

  // 1. identical content (same sha256) for the SAME client: keep one (best folder, newest), the others are skipped
  const groups = new Map();
  pack.files.forEach((f) => { if (!f.clientId) return; const k = `${f.clientId}|${f.sha256}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(f); });
  const keeper = new Map();
  groups.forEach((l, k) => { keeper.set(k, l.reduce((a, b) => (better(b, a) ? b : a))); });
  // identical content filed under DIFFERENT clients is not a duplicate for either of them (each keeps its evidence); listed for the report
  const bySha = new Map();
  pack.files.forEach((f) => { if (!f.clientId) return; if (!bySha.has(f.sha256)) bySha.set(f.sha256, new Set()); bySha.get(f.sha256).add(f.clientId); });

  // 2. clients that exist only because of an agreement: created with the exact printed name
  const ncByKey = new Map((pack.newClients || []).map((n) => [n.key, n]));
  const madeClient = new Map(); // NEW:key -> client
  const clientFor = (f) => {
    if (!String(f.clientId).startsWith('NEW:')) return S.clientById.get(f.clientId);
    const key = f.clientId.slice(4);
    if (madeClient.has(key)) return madeClient.get(key);
    const nc = ncByKey.get(key);
    if (!nc) return null;
    const same = S.clients.filter((c) => sp(c.name) === sp(nc.name));
    let c;
    if (same.length) { // an earlier run (or somebody) already made it: use it, make nothing
      c = same.find((x) => x.ownerDepartment === nc.department) || same[0];
      out.reusedClients.push({ key, name: c.name, clientId: c.id, department: c.ownerDepartment || '', why: 'a client with exactly this name already exists - the agreement is attached to it' });
    } else {
      const notes = `Created from signed agreement import 2026-10-17. Name as printed in "${nc.nameFrom}".${nc.formRow ? ` Other details from the agreement form sheet, row ${nc.formRow}.` : ' Taken from the signed confirmation only (no form-sheet row).'}${nc.formFiledBy ? ` Form filed by: ${nc.formFiledBy}.` : ''} No owner was set.`;
      const data = {
        name: nc.name, legalName: nc.name, ownerDepartment: nc.department, industry: nc.department === 'Medical' ? 'Healthcare' : nc.department, status: 'Active', clientType: 'Direct',
        location: nc.location || null, contactName: nc.contactName || null, contactPhone: nc.contactPhone || null, contactEmail: nc.contactEmail || null, contactDesignation: nc.contactDesignation || null,
        secondaryContactPhone: nc.contactAltPhone || null, commercialNotes: nc.formCharges || null, internalNotes: notes,
      };
      const id = L.create('client', data);
      c = { id, name: nc.name, legalName: nc.name, ownerDepartment: nc.department, location: nc.location || null, industry: data.industry, status: 'Active', clientType: 'Direct', agreementStatus: 'DRAFT', createdAt: new Date() };
      S.clients.push(c); S.clientById.set(id, c);
      out.createdClients.push({ clientId: id, name: nc.name, department: nc.department, departmentFrom: nc.deptFrom, sourcePdf: nc.nameFrom, formRow: nc.formRow || '', location: nc.location || '', contactName: nc.contactName || '', contactPhone: nc.contactPhone || '', contactEmail: nc.contactEmail || '', charges: nc.formCharges || '', files: 0 });
    }
    madeClient.set(key, c);
    return c;
  };

  for (const f of pack.files) {
    const src = path.join(zipDir, f.folder, f.name);
    const key = keyOf(f);
    if (!f.clientId) { out.unmatched.push({ key, kind: f.kind, why: f.notAgreement || f.how, size: f.size, printed: f.printedName || '', sha256: f.sha256, src }); fileRow(f, null, 'NOT LINKED', 'no client could be told'); continue; }
    const gk = `${f.clientId}|${f.sha256}`;
    const keep = keeper.get(gk);
    let client = null;
    if (keep !== f) {
      // a true duplicate: same bytes as the kept twin for the same client. Prove it by hashing it too.
      client = String(f.clientId).startsWith('NEW:') ? (madeClient.get(f.clientId.slice(4)) || null) : S.clientById.get(f.clientId);
      let proof = 'same sha256 in the inventory';
      if (readFiles && fs.existsSync(src)) {
        const sha = crypto.createHash('sha256').update(fs.readFileSync(src)).digest('hex');
        if (sha !== f.sha256) { out.problems.push(`${key}: content differs from the inventory (sha256) - not treated as a duplicate`); }
        else proof = 'identical bytes (sha256 checked when read)';
      }
      out.duplicates.push({ key, client: client ? client.name : (ncByKey.get(String(f.clientId).slice(4)) || {}).name || f.clientId, keptTwin: keyOf(keep), why: `identical content (${proof}); the copy in "${keep.folder.replace(/ \(File responses\)$/, '')}" is kept`, size: f.size, sha256: f.sha256 });
      fileRow(f, client, 'DUPLICATE SKIPPED', `identical content to the kept twin for the same client`, { keptTwin: keyOf(keep) });
      continue;
    }
    client = clientFor(f);
    if (!client) { out.problems.push(`${key}: client ${f.clientId} not found`); out.unmatched.push({ key, kind: f.kind, why: 'client no longer exists', size: f.size, sha256: f.sha256, src }); fileRow(f, null, 'NOT LINKED', 'client no longer exists'); continue; }
    if (haveSha.has(`${client.id}|${f.sha256}`)) { out.duplicates.push({ key, client: client.name, keptTwin: '(already stored by an earlier run)', why: 'already stored for this client by an earlier run', size: f.size, sha256: f.sha256 }); fileRow(f, client, 'ALREADY IMPORTED', 'stored by an earlier run'); continue; }
    let kindOf = null;
    if (readFiles) {
      if (!fs.existsSync(src)) { out.problems.push(`${key}: file not found in the extracted folder`); out.unmatched.push({ key, kind: f.kind, why: 'file missing in extracted zip', size: f.size, sha256: f.sha256, src }); fileRow(f, client, 'NOT STORED', 'file missing in the extracted folder'); continue; }
      const data = fs.readFileSync(src);
      const sha = crypto.createHash('sha256').update(data).digest('hex');
      if (sha !== f.sha256) { out.problems.push(`${key}: content differs from the inventory (sha256)`); out.unmatched.push({ key, kind: f.kind, why: 'content differs from the inventory', size: f.size, sha256: f.sha256, src }); fileRow(f, client, 'NOT STORED', 'content differs from the inventory'); continue; }
      kindOf = sniff(data.slice(0, 8));
      if (!kindOf) out.problems.push(`${key}: first bytes are not PDF / PNG / JPEG / Word - stored as it is, named by its extension`);
    }
    const nameExt = path.extname(f.name).toLowerCase();
    const real = kindOf || { ext: STORE_EXT[f.ext] || f.ext.replace('.', ''), ext2: f.ext, mime: MIME[f.ext] || 'application/octet-stream' };
    const wrongName = !!kindOf && STORE_EXT[nameExt] !== undefined && STORE_EXT[nameExt] !== real.ext;
    const fileName = wrongName ? `${f.name.slice(0, f.name.length - nameExt.length)}${real.ext2}` : f.name;
    const stored = `${crypto.randomBytes(16).toString('hex')}.${real.ext}`;
    const version = (/\((\d+)\)/.exec(f.name) || [])[1];
    const when = dmy(f.isoDate);
    const shown = (f.kind === 'Signed agreement' ? (f.printedName || client.name) : client.name);
    const label = f.kind === 'Signed agreement'
      ? `Signed agreement - ${shown}${when ? ` - ${when}` : ''}${version ? ` (${version})` : ''}`
      : `${f.kind} - ${path.basename(f.name, nameExt)}`.slice(0, 160);
    const docId = newId('jd');
    L.create('clientDocument', {
      clientId: client.id, kind: 'AGREEMENT_SIGNED', name: label.slice(0, 200), fileStored: stored, fileName,
      fileMime: real.mime, fileSize: f.size, pending: false, uploadedByName: 'Imported',
    }, docId);
    const meta = {
      agreementDate: f.isoDate || null, department: client.ownerDepartment || null, branch: f.address ? sp(f.address).slice(0, 120) : null, label: label.slice(0, 200),
      version: version ? `(${version})` : null, folder: f.folder.replace(/ \(File responses\)$/, ''), sha256: f.sha256, kind: f.kind,
      printedName: f.printedName || null, printedDate: f.printedDate || null, uploadedOn: f.uploaded, source: 'All Signed Agreements (File responses) zip, 2026-10-17',
      originalName: wrongName ? f.name : undefined, linkedBy: f.how || undefined, notAgreement: f.notAgreement || undefined,
    };
    L.create('appSetting', { key: `agrsigned.${docId}`, value: JSON.stringify(meta), updatedByName: 'Imported' });
    out.fileOps.push({ src, dst: path.join(uploadsDir, stored), stored, docId, clientId: client.id, bytes: f.size });
    const isNewClient = String(f.clientId).startsWith('NEW:');
    const cc = isNewClient ? out.createdClients.find((x) => x.clientId === client.id) : null;
    if (cc) cc.files += 1;
    out.attached.push({ key, client: client.name, clientId: client.id, docId, label, kind: f.kind, size: f.size, how: f.how, stored, newClient: isNewClient && !!cc, realType: real.ext, nameFixed: wrongName ? fileName : '' });
    fileRow(f, client, isNewClient ? 'ATTACHED (new client)' : 'ATTACHED', f.how, { storedAs: stored, realType: real.ext, nameFixed: wrongName ? fileName : '' });
    const shared = bySha.get(f.sha256);
    if (shared && shared.size > 1) out.sharedContent.push({ key, client: client.name, clientId: client.id, sha256: f.sha256, why: 'the very same file was uploaded for another client too; each client keeps it' });
  }
  // unmatched files are kept on disk (not in the database)
  out.unmatched.forEach((u) => { out.unmatchedOps.push({ src: u.src, dst: path.join(uploadsDir, 'imported-agreements-unmatched', u.key.replace(/[\\/:*?"<>|]+/g, '_').replace(/ \/ /, '__')) }); });
  return out;
}

module.exports = { planRenames, planFiles, dmy };
