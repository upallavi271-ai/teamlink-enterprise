// ---------------------------------------------------------------------------
// SEMANTIC (MEANING-BASED) MATCHING — B8, 2026-10-05.
//
// OFF BY DEFAULT. Admin → Company Setup → Fit settings → "Match by meaning".
// While it is off nothing here runs and every Fit % is exactly what it was.
//
// Two engines, one interface:
//
//   local  (always available, deterministic, offline — nothing leaves the
//          server). Words are folded to one meaning with a synonym list
//          ("ReactJS" = "React.js" = "React"; "accountant" = "accounts
//          executive" = "accounting"), then TF-IDF cosine similarity between
//          the job text and the person's profile + current resume.
//   ai     Ollama embeddings (POST {OLLAMA_BASE_URL}/api/embed, model
//          OLLAMA_EMBED_MODEL, default nomic-embed-text). Claude has no
//          embeddings API, so the AI engine is Ollama only. Used ONLY when
//            1. the semantic switch is on AND the Admin picked the AI engine,
//            2. the login asking holds the Role Catalog AI grant for ATS data
//               (utils/aiAccess.js aiAccessFor → data.ats),
//            3. Ollama answers and the embedding model is pulled,
//            4. not the test sandbox (AI refused there unless TEST_ALLOW_AI=1).
//          Otherwise the local engine answers. The text sent never carries the
//          name, e-mail, phone, address or company (see textOfCandidate).
//          Vectors are cached per person / job in SemanticVector (when the
//          migration is in) or in memory, keyed by a hash of the text, so a
//          changed profile / new resume is embedded again and nothing else is.
//
// PUBLIC API
//   canonicalSkill(s)                 'reactjs' → 'c:react' (or the folded word)
//   sameSkill(a, b)                   true when two skill names mean the same
//   textOfCandidate(c, evidence)      the (PII-free) text a person is matched on
//   textOfRequirement(r)
//   similarities(requirement, pool, evidenceMap, { user, settings })
//                                     → { engine, map: Map(candId → { sim, pct, shared[] }) }
//   jobSimilarities(candidate, evidence, requirements, { user, settings })
//                                     → { engine, map: Map(reqId → { sim, pct, shared[] }) }
//   buildIndex({ user, settings })    background precompute (chunked); status()
//   machineStatus()                   which engine can run on THIS machine
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const http = require('http');
const https = require('https');

// --- 1. the synonym list ------------------------------------------------------
// [canonical, ...ways people write it]. Written in plain lower case; every
// variant goes through the same normaliser as the text, so "React.js",
// "react js" and "ReactJS" all land on 'c:react'. Keep it to SAME-MEANING
// groups (not "related" skills) — a wrong group would make strangers match.
const GROUPS = [
  // software
  ['react', 'react', 'reactjs', 'react.js', 'react js', 'react framework'],
  ['reactnative', 'react native', 'react-native'],
  ['node', 'node', 'nodejs', 'node.js', 'node js'],
  ['javascript', 'javascript', 'java script', 'js', 'ecmascript', 'es6'],
  ['typescript', 'typescript', 'type script', 'ts'],
  ['angular', 'angular', 'angularjs', 'angular.js', 'angular js'],
  ['vue', 'vue', 'vuejs', 'vue.js', 'vue js'],
  ['nextjs', 'next.js', 'nextjs', 'next js'],
  ['express', 'express', 'expressjs', 'express.js'],
  ['dotnet', '.net', 'dotnet', 'dot net', 'asp.net', 'aspnet', 'asp net', '.net core', 'dotnet core'],
  ['csharp', 'c#', 'csharp', 'c sharp'],
  ['cplusplus', 'c++', 'cpp', 'cplusplus'],
  ['golang', 'golang', 'go lang'],
  ['python', 'python', 'python3', 'py'],
  ['postgres', 'postgres', 'postgresql', 'postgre sql', 'psql'],
  ['mysql', 'mysql', 'my sql'],
  ['mssql', 'sql server', 'mssql', 'ms sql', 'microsoft sql server'],
  ['mongodb', 'mongodb', 'mongo', 'mongo db'],
  ['kubernetes', 'kubernetes', 'k8s'],
  ['aws', 'aws', 'amazon web services'],
  ['gcp', 'gcp', 'google cloud', 'google cloud platform'],
  ['azure', 'azure', 'microsoft azure'],
  ['ml', 'machine learning', 'ml'],
  ['ai', 'artificial intelligence', 'ai'],
  ['dl', 'deep learning', 'dl'],
  ['nlp', 'nlp', 'natural language processing'],
  ['restapi', 'rest api', 'rest apis', 'restful', 'restful api', 'restful apis', 'rest'],
  ['qa', 'qa', 'quality assurance', 'software testing', 'tester', 'test engineer', 'testing'],
  ['automationtesting', 'automation testing', 'test automation', 'automated testing'],
  ['manualtesting', 'manual testing', 'manual tester'],
  ['devops', 'devops', 'dev ops'],
  ['ui', 'ui', 'user interface'],
  ['ux', 'ux', 'user experience'],
  ['frontend', 'frontend', 'front end', 'front-end', 'front end developer', 'frontend developer', 'ui developer'],
  ['backend', 'backend', 'back end', 'back-end', 'backend developer', 'back end developer'],
  ['fullstack', 'full stack', 'fullstack', 'full-stack', 'full stack developer', 'mern', 'mean stack'],
  ['swe', 'software engineer', 'software developer', 'software development engineer', 'sde', 'programmer', 'developer'],
  ['powerbi', 'power bi', 'powerbi', 'ms power bi'],
  ['excel', 'excel', 'ms excel', 'microsoft excel', 'advanced excel', 'advance excel'],
  ['msoffice', 'ms office', 'microsoft office', 'ms-office'],
  ['dataanalyst', 'data analyst', 'data analytics', 'data analysis', 'analytics'],
  ['datascience', 'data science', 'data scientist'],
  ['sap', 'sap', 'sap erp'],
  ['crm', 'crm', 'customer relationship management'],
  // accounts / finance / office
  ['accounting', 'accountant', 'accounts', 'accounting', 'accounts executive', 'accounts officer', 'accounts assistant',
    'accounts manager', 'account executive accounts', 'bookkeeping', 'book keeping', 'bookkeeper', 'finance executive',
    'accounts and finance', 'accounts & finance', 'junior accountant', 'senior accountant'],
  ['tally', 'tally', 'tally erp', 'tally erp 9', 'tally prime', 'tallyprime'],
  ['gst', 'gst', 'goods and services tax', 'gst filing', 'gst returns'],
  ['tds', 'tds', 'tax deducted at source'],
  ['ca', 'chartered accountant', 'ca'],
  ['payroll', 'payroll', 'payroll processing', 'salary processing'],
  ['hr', 'hr', 'human resources', 'human resource', 'hrm'],
  ['recruitment', 'recruiter', 'recruitment', 'talent acquisition', 'hiring', 'ta', 'it recruiter', 'non it recruiter', 'sourcing'],
  ['sales', 'sales', 'sales executive', 'business development', 'bde', 'business development executive', 'bdm', 'inside sales'],
  ['marketing', 'marketing', 'marketing executive'],
  ['digitalmarketing', 'digital marketing', 'online marketing', 'social media marketing', 'smm'],
  ['seo', 'seo', 'search engine optimization', 'search engine optimisation'],
  ['customersupport', 'customer support', 'customer service', 'customer care', 'call center', 'call centre', 'bpo',
    'telecaller', 'tele caller', 'voice process', 'customer support executive', 'customer service executive'],
  ['frontoffice', 'front office', 'receptionist', 'front desk', 'front office executive'],
  ['admin', 'admin executive', 'administration', 'office administration', 'office admin', 'administrative assistant'],
  ['dataentry', 'data entry', 'data entry operator', 'deo'],
  ['communication', 'communication', 'communication skills', 'good communication', 'verbal communication'],
  // health care
  ['nursing', 'nurse', 'nursing', 'staff nurse', 'registered nurse', 'rn', 'gnm', 'b sc nursing', 'bsc nursing', 'anm', 'nursing officer'],
  ['doctor', 'doctor', 'physician', 'medical officer', 'mbbs', 'rmo', 'resident medical officer', 'duty doctor', 'general physician'],
  ['pharmacy', 'pharmacist', 'pharmacy', 'b pharm', 'bpharm', 'd pharm', 'dpharm', 'm pharm'],
  ['dermatology', 'dermatology', 'dermatologist', 'skin specialist', 'dvl', 'dermatology venereology leprosy'],
  ['cardiology', 'cardiology', 'cardiologist', 'cardiac'],
  ['pediatrics', 'pediatrics', 'paediatrics', 'pediatrician', 'paediatrician', 'child specialist'],
  ['gynecology', 'gynecology', 'gynaecology', 'gynecologist', 'gynaecologist', 'obgyn', 'ob gyn', 'obstetrics', 'obg'],
  ['orthopedics', 'orthopedics', 'orthopaedics', 'orthopedic', 'orthopaedic', 'ortho'],
  ['radiology', 'radiology', 'radiologist', 'radiographer'],
  ['anesthesia', 'anesthesia', 'anaesthesia', 'anesthesiology', 'anaesthesiology', 'anesthesiologist', 'anaesthetist'],
  ['physiotherapy', 'physiotherapy', 'physiotherapist', 'physio', 'bpt', 'mpt'],
  ['labtech', 'lab technician', 'laboratory technician', 'medical lab technician', 'medical laboratory technician', 'mlt', 'dmlt', 'bmlt', 'lab tech'],
  ['generalsurgery', 'general surgery', 'general surgeon', 'ms general surgery'],
  ['medicine', 'general medicine', 'internal medicine', 'md medicine'],
  ['icu', 'icu', 'intensive care', 'intensive care unit', 'critical care'],
  ['ot', 'ot technician', 'operation theatre technician', 'operation theater technician', 'ot tech'],
  ['medicalcoding', 'medical coding', 'medical coder', 'cpc'],
  ['pharmacovigilance', 'pharmacovigilance', 'drug safety', 'pv'],
  ['clinicalresearch', 'clinical research', 'cra', 'clinical research associate'],
  // engineering / production
  ['qc', 'quality control', 'qc'],
  ['autocad', 'autocad', 'auto cad'],
  ['mechanical', 'mechanical engineer', 'mechanical engineering', 'mech engineer'],
  ['civil', 'civil engineer', 'civil engineering', 'site engineer'],
  ['electrical', 'electrical engineer', 'electrical engineering'],
  ['teaching', 'teacher', 'teaching', 'faculty', 'lecturer', 'tutor', 'trainer'],
];
const STOP = new Set(('a an and or the of to in on at for with by from as is are was were be been being this that these those it its '
  + 'we you your our they them their he she his her i me my will shall can could should would may might must have has had do does did '
  + 'not no yes all any each every more most other some such only own same so than too very just also etc using use used work working '
  + 'experience years year yrs yr good knowledge strong ability skills skill responsible responsibilities role job candidate '
  + 'required requirement requirements preferred must should plus team well level new including within across into per').split(' '));

// Same normaliser for the text and for every synonym variant.
function normWords(text) {
  const s = String(text == null ? '' : text).toLowerCase()
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, ' ') // e-mails
    .replace(/https?:\/\/\S+|www\.\S+/g, ' ') // links
    .replace(/(\+?\d[\d\s-]{8,}\d)/g, ' ') // phone-like digit runs
    .replace(/\.net\b/g, ' dotnet ')
    .replace(/c\+\+/g, ' cplusplus ')
    .replace(/c#/g, ' csharp ')
    .replace(/&/g, ' and ');
  return s.split(/[^a-z0-9]+/).filter(Boolean);
}
// "phrase in normalised words" → canonical key.
const PHRASE = new Map();
let MAX_PHRASE = 1;
GROUPS.forEach(([canon, ...variants]) => {
  [canon, ...variants].forEach((v) => {
    const w = normWords(v);
    if (!w.length) return;
    const key = w.join(' ');
    if (!PHRASE.has(key)) PHRASE.set(key, canon);
    MAX_PHRASE = Math.max(MAX_PHRASE, w.length);
  });
});
// A single word joined from a two-word variant also folds ("reactjs" is in
// the list; "nodejs" too). Light plural folding for the rest.
const stem = (w) => (w.length > 4 && w.endsWith('ies') ? `${w.slice(0, -3)}y`
  : (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') ? w.slice(0, -1) : w));

// text → array of terms ('c:react' for a known meaning, else the folded word).
function terms(text) {
  const w = normWords(text);
  const out = [];
  for (let i = 0; i < w.length;) {
    let hit = null;
    for (let n = Math.min(MAX_PHRASE, w.length - i); n >= 1; n -= 1) {
      const key = w.slice(i, i + n).join(' ');
      const canon = PHRASE.get(key) || (n === 1 ? PHRASE.get(stem(key)) : null);
      if (canon) { hit = { canon, n }; break; }
    }
    if (hit) { out.push(`c:${hit.canon}`); i += hit.n; continue; }
    const t = stem(w[i]);
    if (t.length >= 2 && !STOP.has(t) && !STOP.has(w[i]) && !/^\d+$/.test(t)) out.push(t);
    i += 1;
  }
  return out;
}

// One skill name → one key. Two skill names mean the same when their keys
// are equal ("ReactJS" / "React.js" → 'c:react').
// Memoised: the same few thousand skill names come round for every person.
const canonCache = new Map();
function canonicalSkill(s) {
  const raw = String(s || '');
  const hit = canonCache.get(raw);
  if (hit !== undefined) return hit;
  const t = terms(raw);
  const out = t.length ? t.join(' ') : raw.trim().toLowerCase();
  if (canonCache.size > 50000) canonCache.clear();
  canonCache.set(raw, out);
  return out;
}
const sameSkill = (a, b) => canonicalSkill(a) === canonicalSkill(b);
// Every way a canonical meaning is written (used to find a skill in a resume).
const VARIANTS = new Map(GROUPS.map(([canon, ...v]) => [`c:${canon}`, [canon, ...v]]));
function variantsOf(skill) {
  const key = canonicalSkill(skill);
  return key.startsWith('c:') && !key.includes(' ') ? (VARIANTS.get(key) || [skill]) : [skill];
}
const labelOf = (t) => (t.startsWith('c:') ? (VARIANTS.get(t) || [t.slice(2)])[1] || t.slice(2) : t);

// --- 2. the text a match reads -------------------------------------------------
// NO name, e-mail, phone, address, company, salary: only what describes the
// work. Resume text is cut to 6,000 characters and its contact lines stripped
// by normWords (e-mails, links, phone numbers).
const RESUME_CHARS = 6000;
function textOfCandidate(c, ev) {
  const parts = [c.skills, c.technicalSkills, c.goodToHaveSkills, c.specialization, c.currentDesignation, c.education];
  let resume = ev && ev.text ? String(ev.text).slice(0, RESUME_CHARS) : '';
  if (resume && c.name) {
    // The person's own name never travels with their resume.
    String(c.name).split(/\s+/).filter((p) => p.length >= 3).forEach((p) => {
      resume = resume.replace(new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' ');
    });
  }
  if (ev && ev.parsed && Array.isArray(ev.parsed.skills)) parts.push(ev.parsed.skills.join(', '));
  parts.push(resume);
  return parts.filter(Boolean).join('\n');
}
function textOfRequirement(r) {
  // The title and the skills count twice: they say what the job IS.
  return [r.title, r.title, r.skills, r.skills, r.goodToHaveSkills, r.specialisation, r.department, r.education,
    r.qualifications, r.description, r.jobDescription, r.responsibilities].filter(Boolean).join('\n').slice(0, 8000);
}
const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');

// --- 3. the local engine: TF-IDF over the folded terms --------------------------
// One in-memory index of people: Map(candId → { key, tf: Map(term → w), norm }).
// df / N are kept up to date as entries change. A person is re-read only when
// their text key (profile fields + resume id) changes.
// Compact on purpose (16.9k people stay a few MB): every term is interned to
// an integer once; a person is two typed arrays (term ids, weights) + a norm.
const local = {
  docs: new Map(), N: 0, builtAt: null,
};
const termId = new Map(); // term → id
const termOf = []; // id → term
const dfArr = []; // id → how many people have the term
function idOf(t, create) {
  let id = termId.get(t);
  if (id === undefined && create) { id = termOf.length; termId.set(t, id); termOf.push(t); dfArr.push(0); }
  return id;
}
function tfOf(list) {
  const tf = new Map();
  list.forEach((t) => tf.set(t, (tf.get(t) || 0) + 1));
  // Sub-linear tf; a known meaning ('c:…') counts double — it is the signal.
  tf.forEach((n, t) => tf.set(t, (1 + Math.log(n)) * (t.startsWith('c:') ? 2 : 1)));
  return tf;
}
const idfId = (id) => Math.log((local.N + 1) / ((id === undefined ? 0 : dfArr[id]) + 1)) + 1;
function normOf(d) {
  let s = 0;
  for (let i = 0; i < d.ids.length; i += 1) { const x = d.w[i] * idfId(d.ids[i]); s += x * x; }
  return Math.sqrt(s) || 1;
}
function putDoc(id, key, text) {
  const old = local.docs.get(id);
  if (old && old.key === key) return false;
  if (old) old.ids.forEach((t) => { dfArr[t] = Math.max(0, dfArr[t] - 1); });
  else local.N += 1;
  const tf = tfOf(terms(text));
  const ids = new Int32Array(tf.size);
  const w = new Float32Array(tf.size);
  let i = 0;
  tf.forEach((v, t) => { const tid = idOf(t, true); ids[i] = tid; w[i] = v; dfArr[tid] += 1; i += 1; });
  local.docs.set(id, {
    key, ids, w, norm: 0,
  });
  return true;
}
// The key that says "this person's text changed": the profile fields plus the
// resume version id (a resume version is immutable, so its id is enough).
const keyOf = (c, ev) => `${[c.skills, c.technicalSkills, c.goodToHaveSkills, c.specialization, c.currentDesignation, c.education].join('|')}#${ev ? ev.resumeId : ''}`;

function refreshLocal(pool, evidence) {
  let changed = 0;
  pool.forEach((c) => {
    const ev = evidence ? evidence.get(c.id) : null;
    const key = keyOf(c, ev);
    const d = local.docs.get(c.id);
    if (d && d.key === key) return;
    if (putDoc(c.id, key, textOfCandidate(c, ev))) changed += 1;
  });
  // Norms depend on the IDF; recompute those that are new, and every norm
  // when a lot moved (first build, a big import).
  const all = changed > Math.max(50, local.N * 0.05);
  local.docs.forEach((d) => { if (all || !d.norm) d.norm = normOf(d); });
  if (changed) local.builtAt = new Date();
  return changed;
}
// The job side: Map(termId → tf-idf weight). Terms no person has are left
// out of the dot product but still count in the job's own norm.
function queryVec(text) {
  const tf = tfOf(terms(text));
  const q = new Map();
  let s = 0;
  tf.forEach((w, t) => {
    const id = idOf(t, false);
    const x = w * idfId(id);
    if (id !== undefined) q.set(id, x);
    s += x * x;
  });
  return { q, norm: Math.sqrt(s) || 1 };
}
function cosLocal(qv, d) {
  let dot = 0;
  for (let i = 0; i < d.ids.length; i += 1) {
    const x = qv.q.get(d.ids[i]);
    if (x !== undefined) dot += x * d.w[i] * idfId(d.ids[i]);
  }
  return dot / (qv.norm * (d.norm || normOf(d)));
}
// The words the job and the person share, strongest first (for the screen).
function sharedOf(qv, d) {
  const out = [];
  for (let i = 0; i < d.ids.length; i += 1) {
    const x = qv.q.get(d.ids[i]);
    if (x !== undefined) out.push([termOf[d.ids[i]], x * d.w[i] * idfId(d.ids[i])]);
  }
  return out.sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t]) => labelOf(t));
}
// Cosine → the % shown. TF-IDF cosine between a short job and a profile is
// small in absolute terms, so the square root spreads it: 0.8 = 100%,
// 0.5 = 79%, 0.3 = 61%, 0.1 = 35%.
const LOCAL_FULL = 0.8;
const localPct = (sim) => Math.max(0, Math.min(100, Math.round(Math.sqrt(Math.max(0, sim) / LOCAL_FULL) * 100)));
// Only people this close get their shared words worked out (the rest are
// never shown or explained).
const SHARED_FROM_PCT = 40;
// A job's vector, cached while its text and the index size stay the same
// (the person → jobs list reads ~2,500 jobs at a time).
const jobCache = new Map(); // reqId → { text, N, qv }
function jobVec(r) {
  const text = textOfRequirement(r);
  const hit = jobCache.get(r.id);
  if (hit && hit.text === text && Math.abs(hit.N - local.N) <= Math.max(5, local.N * 0.01)) return hit.qv;
  const qv = queryVec(text);
  if (jobCache.size > 20000) jobCache.clear();
  jobCache.set(r.id, { text, N: local.N, qv });
  return qv;
}

// --- 4. the AI engine: Ollama embeddings ---------------------------------------
const ollamaBase = () => String(process.env.OLLAMA_BASE_URL || 'http://localhost:11434').trim().replace(/\/+$/, '');
const embedModel = () => String(process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text').trim();
function httpJson(method, url, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = payload ? Buffer.from(JSON.stringify(payload)) : null;
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      method, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: `${u.pathname}${u.search}`,
      headers: body ? { 'content-type': 'application/json', 'content-length': body.length } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
        try { return resolve(JSON.parse(txt)); } catch { return reject(new Error('bad JSON')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });
}
const sandbox = () => require('./sandbox'); // eslint-disable-line global-require
// Is Ollama reachable and is the embedding model pulled? Cached 30 s. Never
// throws. In the sandbox AI is refused unless TEST_ALLOW_AI=1.
let machineCache = null;
async function machineStatus({ fresh = false } = {}) {
  if (!fresh && machineCache && Date.now() - machineCache.at < 30000) return machineCache.value;
  const value = {
    ollamaUrl: ollamaBase(), embedModel: embedModel(), ollamaReachable: false, modelPulled: false, models: [], refused: null,
  };
  const sb = sandbox();
  if (sb.isSandbox() && !sb.allowAi()) value.refused = 'Test copy: AI is switched off here.';
  else {
    try {
      const tags = await httpJson('GET', `${ollamaBase()}/api/tags`, null, 3000);
      value.ollamaReachable = true;
      value.models = (tags.models || []).map((m) => m.name);
      const want = embedModel();
      value.modelPulled = value.models.some((n) => n === want || n.split(':')[0] === want.split(':')[0]);
    } catch { /* not reachable */ }
  }
  value.aiReady = value.ollamaReachable && value.modelPulled && !value.refused;
  value.summary = value.aiReady
    ? `AI engine ready: Ollama with ${value.embedModel}.`
    : value.refused || (value.ollamaReachable
      ? `Ollama is running, but the embedding model "${value.embedModel}" is not installed — the built-in offline engine is used. (To use the AI engine, an admin runs: ollama pull ${value.embedModel})`
      : 'Ollama is not running on this server — the built-in offline engine is used.');
  machineCache = { at: Date.now(), value };
  return value;
}
async function embed(texts) {
  const sb = sandbox();
  if (sb.isSandbox() && !sb.allowAi()) throw new Error('sandbox');
  const out = await httpJson('POST', `${ollamaBase()}/api/embed`, { model: embedModel(), input: texts }, 120000);
  if (!out || !Array.isArray(out.embeddings) || out.embeddings.length !== texts.length) throw new Error('no embeddings');
  return out.embeddings.map((v) => Float32Array.from(v));
}
function cosVec(a, b) {
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length && i < b.length; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
// Embedding cosine between related texts sits around 0.45–0.85.
const aiPct = (sim) => Math.max(0, Math.min(100, Math.round(((sim - 0.35) / 0.45) * 100)));

// Vector cache: SemanticVector rows when the migration is in, else memory.
const vecMem = new Map(); // `${kind}:${id}` → { hash, vec }
let prismaRef = null;
const prisma = () => { if (!prismaRef) prismaRef = require('../db'); return prismaRef; }; // eslint-disable-line global-require
function vectorTable() {
  try { return !!require('./resumeMatch').hasField('SemanticVector', 'vector'); } catch { return false; } // eslint-disable-line global-require
}
async function loadVectors(kind, ids) {
  const out = new Map();
  ids.forEach((id) => { const m = vecMem.get(`${kind}:${id}`); if (m) out.set(id, m); });
  if (vectorTable() && out.size < ids.length) {
    const rows = await prisma().semanticVector.findMany({ where: { kind, model: embedModel() }, select: { refId: true, hash: true, vector: true } });
    const want = new Set(ids);
    rows.forEach((r) => {
      if (!want.has(r.refId) || out.has(r.refId)) return;
      const buf = Buffer.from(r.vector);
      const v = { hash: r.hash, vec: new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4)) };
      vecMem.set(`${kind}:${r.refId}`, v);
      out.set(r.refId, v);
    });
  }
  return out;
}
async function saveVector(kind, id, hash, vec) {
  vecMem.set(`${kind}:${id}`, { hash, vec });
  if (!vectorTable()) return;
  const data = {
    hash, dims: vec.length, vector: Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength),
  };
  await prisma().semanticVector.upsert({
    where: { kind_refId_model: { kind, refId: id, model: embedModel() } },
    create: { kind, refId: id, model: embedModel(), ...data },
    update: data,
  });
}

// --- 5. who may use which engine ---------------------------------------------------
async function aiAllowedFor(user) {
  if (!user) return false;
  try {
    const access = await require('./aiAccess').aiAccessFor(user); // eslint-disable-line global-require
    return !!(access && access.ask && access.data && access.data.ats);
  } catch { return false; }
}
// 'off' | 'local' | 'ai', plus why (for the screen).
async function engineFor(user, settings) {
  const s = (settings && settings.semantic) || {};
  if (!s.on) return { engine: 'off', why: 'Match by meaning is off.' };
  if (s.engine !== 'ai') return { engine: 'local', why: 'Built-in offline engine (nothing leaves the server).' };
  const [m, allowed] = await Promise.all([machineStatus(), aiAllowedFor(user)]);
  if (!allowed) return { engine: 'local', why: 'Your role has no AI access for ATS data (Role Catalog), so the built-in offline engine is used.' };
  if (!m.aiReady) return { engine: 'local', why: m.summary };
  return { engine: 'ai', why: m.summary };
}

// --- 6. background precompute ----------------------------------------------------------
const job = {
  state: 'idle', engine: null, done: 0, total: 0, startedAt: null, finishedAt: null, error: null,
};
const status = () => ({
  ...job, localIndexed: local.N, localBuiltAt: local.builtAt, vectorsInMemory: vecMem.size, vectorTable: vectorTable(),
});
const POOL_SELECT = {
  id: true, name: true, skills: true, technicalSkills: true, goodToHaveSkills: true, specialization: true,
  currentDesignation: true, education: true,
};
// Builds the local index (seconds) and, for the AI engine, the missing /
// stale vectors in chunks of 16, yielding between chunks so the server keeps
// answering. One run at a time.
async function buildIndex({ user, settings } = {}) {
  if (job.state === 'running') return status();
  const { engine } = await engineFor(user, settings);
  Object.assign(job, {
    state: 'running', engine, done: 0, total: 0, startedAt: new Date(), finishedAt: null, error: null,
  });
  setImmediate(async () => {
    try {
      const rm = require('./resumeMatch'); // eslint-disable-line global-require
      const pool = await prisma().candidate.findMany({ select: POOL_SELECT });
      const evidence = await rm.currentResumeEvidence(pool.map((c) => c.id));
      job.total = pool.length;
      refreshLocal(pool, evidence);
      job.done = engine === 'ai' ? 0 : pool.length;
      if (engine === 'ai') {
        const have = await loadVectors('CANDIDATE', pool.map((c) => c.id));
        const todo = pool.map((c) => ({ c, text: textOfCandidate(c, evidence.get(c.id)) }))
          .map((x) => ({ ...x, hash: sha1(x.text) }))
          .filter((x) => { const h = have.get(x.c.id); return !(h && h.hash === x.hash); });
        job.done = pool.length - todo.length;
        for (let i = 0; i < todo.length; i += 16) {
          const chunk = todo.slice(i, i + 16);
          // eslint-disable-next-line no-await-in-loop
          const vecs = await embed(chunk.map((x) => x.text || '-'));
          // eslint-disable-next-line no-await-in-loop
          for (let k = 0; k < chunk.length; k += 1) await saveVector('CANDIDATE', chunk[k].c.id, chunk[k].hash, vecs[k]);
          job.done += chunk.length;
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => { setImmediate(r); });
        }
      }
      job.state = 'done';
    } catch (err) {
      job.state = 'failed';
      job.error = String((err && err.message) || err).slice(0, 160);
    } finally {
      job.finishedAt = new Date();
    }
  });
  return status();
}

// --- 7. the two directions -------------------------------------------------------------
// job → people. pool rows need POOL_SELECT fields (+ id). Returns the engine
// actually used and Map(candId → { sim, pct, shared }).
async function similarities(requirement, pool, evidence, { user, settings } = {}) {
  const pick = await engineFor(user, settings);
  const map = new Map();
  if (pick.engine === 'off') return { ...pick, map };
  if (pick.engine === 'ai') {
    const have = await loadVectors('CANDIDATE', pool.map((c) => c.id));
    const missing = pool.filter((c) => !have.has(c.id)).length;
    if (missing === 0 || missing < pool.length * 0.02) {
      try {
        const rText = textOfRequirement(requirement);
        const rHash = sha1(rText);
        let rv = (await loadVectors('REQUIREMENT', [requirement.id])).get(requirement.id);
        if (!rv || rv.hash !== rHash) { const [v] = await embed([rText]); await saveVector('REQUIREMENT', requirement.id, rHash, v); rv = { hash: rHash, vec: v }; }
        refreshLocal(pool, evidence); // the "shared words" line still comes from the folded terms
        const qv = queryVec(rText);
        pool.forEach((c) => {
          const h = have.get(c.id);
          if (!h) return;
          const sim = cosVec(rv.vec, h.vec);
          const d = local.docs.get(c.id);
          const pct = aiPct(sim);
          map.set(c.id, { sim, pct, shared: d && pct >= SHARED_FROM_PCT ? sharedOf(qv, d) : [] });
        });
        return { ...pick, map };
      } catch {
        pick.why = 'The AI engine did not answer, so the built-in offline engine was used.';
      }
    } else {
      pick.why = `The AI index is still being built (${pool.length - missing} of ${pool.length}); the built-in offline engine is used until then.`;
    }
    pick.engine = 'local';
  }
  refreshLocal(pool, evidence);
  const qv = queryVec(textOfRequirement(requirement));
  pool.forEach((c) => {
    const d = local.docs.get(c.id);
    if (!d) return;
    const sim = cosLocal(qv, d);
    const pct = localPct(sim);
    map.set(c.id, { sim, pct, shared: pct >= SHARED_FROM_PCT ? sharedOf(qv, d) : [] });
  });
  return { ...pick, map };
}

// person → jobs (the candidate's "Eligible jobs" list). Local engine only for
// the job side vectors' IDF; the AI engine is used when both vectors exist.
async function jobSimilarities(candidate, ev, requirements, { user, settings } = {}) {
  const pick = await engineFor(user, settings);
  const map = new Map();
  if (pick.engine === 'off') return { ...pick, map };
  refreshLocal([candidate], ev ? new Map([[candidate.id, ev]]) : null);
  const d = local.docs.get(candidate.id);
  if (pick.engine === 'ai') {
    try {
      const text = textOfCandidate(candidate, ev);
      const hash = sha1(text);
      let cv = (await loadVectors('CANDIDATE', [candidate.id])).get(candidate.id);
      if (!cv || cv.hash !== hash) { const [v] = await embed([text]); await saveVector('CANDIDATE', candidate.id, hash, v); cv = { hash, vec: v }; }
      const have = await loadVectors('REQUIREMENT', requirements.map((r) => r.id));
      const todo = requirements.filter((r) => { const h = have.get(r.id); return !h || h.hash !== sha1(textOfRequirement(r)); });
      for (let i = 0; i < todo.length; i += 16) {
        const chunk = todo.slice(i, i + 16);
        // eslint-disable-next-line no-await-in-loop
        const vecs = await embed(chunk.map((r) => textOfRequirement(r)));
        // eslint-disable-next-line no-await-in-loop
        for (let k = 0; k < chunk.length; k += 1) { await saveVector('REQUIREMENT', chunk[k].id, sha1(textOfRequirement(chunk[k])), vecs[k]); have.set(chunk[k].id, vecMem.get(`REQUIREMENT:${chunk[k].id}`)); }
      }
      requirements.forEach((r) => {
        const h = have.get(r.id);
        if (!h) return;
        const sim = cosVec(cv.vec, h.vec);
        const pct = aiPct(sim);
        map.set(r.id, { sim, pct, shared: d && pct >= SHARED_FROM_PCT ? sharedOf(jobVec(r), d) : [] });
      });
      return { ...pick, map };
    } catch {
      pick.engine = 'local';
      pick.why = 'The AI engine did not answer, so the built-in offline engine was used.';
    }
  }
  if (!d) return { ...pick, map };
  if (!d.norm) d.norm = normOf(d);
  requirements.forEach((r) => {
    const qv = jobVec(r);
    const sim = cosLocal(qv, d);
    const pct = localPct(sim);
    map.set(r.id, { sim, pct, shared: pct >= SHARED_FROM_PCT ? sharedOf(qv, d) : [] });
  });
  return { ...pick, map };
}

module.exports = {
  terms, canonicalSkill, sameSkill, variantsOf, textOfCandidate, textOfRequirement, similarities, jobSimilarities,
  buildIndex, status, machineStatus, engineFor, aiAllowedFor, POOL_SELECT, embed, embedModel,
  _local: local, // tests only
};
