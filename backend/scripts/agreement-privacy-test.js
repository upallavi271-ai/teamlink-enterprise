#!/usr/bin/env node
// ---------------------------------------------------------------------------
// AGREEMENTS ARE NOT FOR TLs / STLs / RECRUITERS / HR (user, 2026-10-12:
// "TLs ki, recruiters ki agreements visible avvakudadu"). SANDBOX ONLY.
//
//   cd backend && TL_API=http://localhost:4011 node scripts/agreement-privacy-test.js [--list]
//
// Logs in (minted token) as a ZZTEST TL, STL, Recruiter and HR and calls EVERY ATS-side GET endpoint the app
// has (the route table is read from the app itself), plus a list of POST read-only endpoints (search, exports,
// reports, assistant), and scans the JSON / text / CSV for agreement words:
//   keys:    agreement*, esign*, signedCopy ...
//   values:  "agreement", "unsigned", "e-sign" in any short text (titles, chips, notices, notifications)
// Control logins (Admin, BDE TL, BDE) must still see them (proves the scanner works).
// ---------------------------------------------------------------------------
const Z = require('./lib/zzfix')('AP');
const { prisma, call, check } = Z;
const { listRoutes } = require('./lib/listRoutes');

const LIST = process.argv.includes('--list');
const KEY_RE = /agreement|^esign|e_sign|signedcopy|unsigned|gatedrequirements/i;
const VAL_RE = /agreement|unsigned|\be-?sign|\bAGR\d{3,}\b|jobs? (?:wait|waiting) for the client|signed copy/i;
// Free text typed by people (job descriptions, notes, chat) may say "agreement" without it being an app leak.
const FREE_TEXT_KEYS = /^(description|jd|jobDescription|notes?|comment|comments|remarks?|body|text|summary|requirements?Text|responsibilities|skills|about|reason|bio|resumeText|rawText|content|message|snippet|html|detail|title)$/i;

// an object / list of only false / empty things (a permission map saying "no") is not a leak
function hasTruth(v, d = 0) {
  if (v === null || v === undefined || v === '' || v === false || v === 0 || d > 8) return false;
  if (Array.isArray(v)) return v.some((x) => hasTruth(x, d + 1));
  if (typeof v === 'object') return Object.values(v).some((x) => hasTruth(x, d + 1));
  return true;
}
function scan(v, p, out, depth = 0) {
  if (depth > 12 || v === null || v === undefined) return;
  if (Array.isArray(v)) { v.slice(0, 400).forEach((x, i) => scan(x, `${p}[]`, out, depth + 1)); return; }
  if (typeof v === 'object') {
    Object.keys(v).forEach((k) => {
      if (KEY_RE.test(k) && !/^nameAgreement$/.test(k) && hasTruth(v[k])) out.add(`key ${p}.${k}`);
      scan(v[k], `${p}.${k}`, out, depth + 1);
    });
    return;
  }
  if (typeof v === 'string' && v.length <= 160 && VAL_RE.test(v)) {
    const key = p.split('.').pop();
    out.add(`${FREE_TEXT_KEYS.test(key) ? 'text' : 'value'} ${p} = ${v.slice(0, 70)}`);
  }
}
const leaksOf = (res) => {
  const out = new Set();
  if (res.body && typeof res.body === 'object') scan(res.body, '$', out);
  else if (res.text && res.status < 300 && VAL_RE.test(res.text.slice(0, 200000)) && !/^\s*</.test(res.text)) out.add(`text-body ${(res.text.match(VAL_RE) || [''])[0]}`);
  return [...out];
};

(async () => {
  await Z.preclean();
  const touched = [];
  try {
    const { RUN } = Z;
    const mk = (tag, extra, emp) => Z.mkUser(tag, extra, emp);
    const dep = { atsDepartment: 'Education', atsScopeDepartments: 'Education' };
    const uTl = await mk('tl', { role: 'TL', atsRole: 'TL', ...dep }, { designation: 'TL' });
    const uStl = await mk('stl', { role: 'EMPLOYEE', atsRole: 'STL', ...dep }, { designation: 'STL' });
    const uRec = await mk('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', ...dep }, { tl: uTl.name });
    const uHr = await mk('hr', { role: 'EMPLOYEE', atsRole: 'HR', hrmsRole: 'HR', hrmsAccess: true }, {});
    const uAdmin = await mk('admin', { role: 'ADMIN', atsRole: 'ADMIN' });
    const uBdeTl = await mk('bdetl', { role: 'TL', atsRole: 'TL', atsDepartment: 'BDE', atsScopeDepartments: 'BDE' }, { designation: 'TL' });
    const uBde = await mk('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Education' }, { tl: uBdeTl.name });
    const client = await prisma.client.create({
      data: {
        name: `ZZTEST AP Client ${RUN}`, location: 'ZZ Town', ownerDepartment: 'Education', bdeOwner: uBde.name, clientType: 'Client', contactName: 'ZZ Contact', contactEmail: `zz-ap-${RUN}@example.test`,
        agreementStatus: 'SENT', agreementId: `AGR9${RUN.slice(0, 3).replace(/\D/g, '1')}01`, agreementSentAt: new Date(), agreementStart: '2026-04-01', agreementEnd: '2027-03-31', agreementFeePercent: 8.33,
        agreementDocument: 'ZZTEST agreement text', paymentTerms: 'within 6 days', guaranteePeriod: '1 month', clientCode: `ZZAP${RUN.toUpperCase()}`,
      },
    });
    Z.made.clients.push(client.id);
    const mkReq = async (key, extra = {}) => {
      const j = await prisma.requirement.create({ data: { title: `ZZTEST AP Job ${key} ${RUN}`, clientId: client.id, status: 'OPEN', department: 'Education', bdeId: uBde.id, tlId: uTl.id, recruiterId: uRec.id, openings: 2, ...extra } });
      Z.made.reqs.push(j.id); return j;
    };
    const jobOpen = await mkReq('open');
    const jobDraft = await mkReq('draft', { status: 'DRAFT' });
    const tok = {};
    for (const [k, u] of Object.entries({ tl: uTl, stl: uStl, rec: uRec, hr: uHr, admin: uAdmin, bdeTl: uBdeTl, bde: uBde })) tok[k] = await Z.mint(u);

    // ---------------- targeted checks (the leaks the crawl cannot reach by itself) ----------------
    const jobHeld = await mkReq('held', { status: 'AGREEMENT_CHECK' });
    const cand = await prisma.candidate.create({ data: { name: `ZZTEST AP Cand ${RUN}`, email: `zz-ap-cand-${RUN}@example.test`, phone: `98000${String(RUN.replace(/\D/g, '') + '00000').slice(0, 5)}`, location: 'ZZ' } });
    Z.made.cands.push(cand.id);
    const BLIND = ['tl', 'stl', 'rec', 'hr'];
    const noWord = (x) => !/agreement|unsigned|\be-?sign/i.test(typeof x === 'string' ? x : JSON.stringify(x || {}));
    for (const role of ['tl', 'rec']) {
      const base = await call('GET', '/api/requirements', tok[role]);
      const f1 = await call('GET', '/api/requirements?agreement=pending', tok[role]);
      const f2 = await call('GET', '/api/requirements?view=agreement', tok[role]);
      const f3 = await call('GET', '/api/requirements?status=AGREEMENT_CHECK', tok[role]);
      const n = (r) => (Array.isArray(r.body) ? r.body.length : -1);
      check(`T1 ${role}: the "agreement pending" filter / view / status do nothing (they would tell which jobs wait)`, n(base) >= 1 && n(f1) === n(base) && n(f3) === n(base) && n(f2) >= 0, [n(base), n(f1), n(f2), n(f3)]);
      const det = await call('GET', `/api/requirements/${jobHeld.id}`, tok[role]);
      check(`T2 ${role}: a job held back shows as Draft with the one hold sentence, and no agreement word`, det.status === 200 && det.body.status === 'DRAFT' && det.body.gate && det.body.gate.onHold === true && det.body.gate.message === 'This requirement is on hold. Ask your Business Development manager.' && noWord(det.body), [det.status, det.body && det.body.gate, det.body && det.body.status]);
      const add = await call('POST', '/api/applications', tok[role], { candidateId: cand.id, requirementId: jobHeld.id });
      check(`T3 ${role}: adding a person to a held job is refused in neutral words`, add.status >= 400 && add.status < 500 && noWord(add.body), [add.status, add.body]);
    }
    for (const role of BLIND) {
      const c1 = await call('GET', `/api/clients/${client.id}`, tok[role]);
      check(`T4 ${role}: the client record has no agreement field`, (c1.status === 403 || noWord(c1.body)) && !('agreementStatus' in (c1.body || {})), [c1.status, Object.keys(c1.body || {}).filter((k) => /agree/i.test(k))]);
      const ag = await call('GET', '/api/agreement/list', tok[role]);
      const ag2 = await call('GET', `/api/agreement/${client.id}`, tok[role]);
      const ag3 = await call('GET', `/api/agreement/${client.id}/executed`, tok[role]);
      check(`T5 ${role}: the agreement register / one agreement / its summary are closed (403 or empty)`, (ag.status === 403 || (ag.body && (ag.body.rows || []).length === 0)) && ag2.status === 403 && ag3.status === 403, [ag.status, ag2.status, ag3.status]);
      const ex = await call('POST', '/api/ats-io/export/agreements?format=csv', tok[role], {});
      check(`T6 ${role}: the agreement register can not be exported`, ex.status === 403, ex.status);
      const acc = await call('GET', '/api/ats-io/access', tok[role]);
      check(`T7 ${role}: the import / export lists have no agreement kind or column`, acc.status === 200 ? noWord(acc.body) : acc.status === 403, [acc.status, [...new Set(JSON.stringify(acc.body || {}).match(/[^"]{0,30}greement[^"]{0,20}/g) || [])].slice(0, 4)]);
      const se = await call('GET', `/api/ats/search?q=${encodeURIComponent('AGZZ')}`, tok[role]);
      check(`T8 ${role}: searching for an agreement number finds nothing`, se.status === 403 || ((se.body.clients || []).length === 0), [se.status, (se.body.clients || []).length]);
      const tp = await call('GET', '/api/messaging/templates/usable', tok[role]);
      check(`T9 ${role}: no "agreement link" message template or token is offered`, tp.status === 403 || noWord(tp.body), tp.status);
      const as = await call('POST', '/api/assistant/ask', tok[role], { message: 'Which of my clients has an unsigned agreement?', page: '/clients' });
      check(`T10 ${role}: the assistant does not discuss agreements`, as.status === 403 || (as.status === 200 && noWord(as.body.answer)), [as.status, as.body && as.body.answer]);
      const me = await call('GET', '/api/auth/me', tok[role]);
      check(`T11 ${role}: the permission map shows no agreement feature as allowed`, me.status === 200 && noWord(me.body.access || {}) , me.status);
    }
    // bell: a line about an agreement never reaches them, an ordinary one does
    const NOTE = require(require('path').join(Z.BACK, 'src/utils/notify.js'));
    await NOTE.notifyUsers([uTl.id, uStl.id, uRec.id, uHr.id, uAdmin.id, uBdeTl.id, uBde.id], { title: `ZZTEST AP agreement now Active ${RUN}`, message: 'ZZTEST AP the agreement was signed' });
    await NOTE.notifyUsers([uTl.id, uRec.id], { title: `ZZTEST AP Job ready to resign design ${RUN}`, message: 'ZZTEST AP job assign design' });
    const seen = async (u, re) => (await prisma.notification.count({ where: { userId: u.id, title: { contains: re } } }));
    check('T12 a notification about an agreement is written for Admin, BDE TL and BDE, never for TL / STL / Recruiter / HR',
      (await seen(uTl, 'agreement')) === 0 && (await seen(uStl, 'agreement')) === 0 && (await seen(uRec, 'agreement')) === 0 && (await seen(uHr, 'agreement')) === 0
      && (await seen(uAdmin, 'agreement')) === 1 && (await seen(uBdeTl, 'agreement')) === 1 && (await seen(uBde, 'agreement')) === 1, null);
    check('T13 ... but an ordinary line with "assign" / "design" / "resign" still reaches the TL and the recruiter', (await seen(uTl, 'resign design')) === 1 && (await seen(uRec, 'resign design')) === 1, null);
    await prisma.notification.create({ data: { userId: uTl.id, title: `ZZTEST AP old agreement line ${RUN}`, message: 'ZZTEST AP' } });
    const bell = await call('GET', '/api/admin/notifications', tok.tl);
    check('T14 even an old stored agreement line is not listed for a TL', bell.status === 200 && !(bell.body || []).some((x) => /agreement/i.test(`${x.title} ${x.message}`)) && (bell.body || []).some((x) => /resign design/.test(x.title)), [bell.status, (bell.body || []).length]);
    const pg = await call('GET', '/api/admin/notifications?page=1&pageSize=50', tok.tl);
    check('T15 ... and the paged list likewise', pg.status === 200 && !(pg.body.rows || []).some((x) => /agreement/i.test(`${x.title} ${x.message}`)), pg.status);
    const adminBell = await call('GET', '/api/admin/notifications', tok.admin);
    check('T16 the Admin still gets them', (adminBell.body || []).some((x) => /agreement/i.test(x.title)), (adminBell.body || []).length);
    // who still sees agreements (control)
    for (const role of ['admin', 'bdeTl', 'bde']) {
      const r1 = await call('GET', `/api/clients/${client.id}`, tok[role]);
      check(`T17 control: ${role} still sees the agreement status of the client`, r1.status === 200 && r1.body.agreementStatus === 'SENT', [r1.status, r1.body && r1.body.agreementStatus]);
      const r2 = await call('GET', `/api/requirements/${jobHeld.id}`, tok[role]);
      check(`T18 control: ${role} still sees the agreement card of a held job`, r2.status === 200 && r2.body.agreement && r2.body.status === 'AGREEMENT_CHECK', [r2.status, r2.body && r2.body.status]);
    }
    const bdeAg = await call('GET', `/api/agreement/${client.id}`, tok.bdeTl);
    check('T19 control: the BDE team lead still opens the agreement (the TL view was cut, hers was not)', bdeAg.status === 200, bdeAg.status);

    // ---------------- the endpoints ----------------
    const PREFIXES = ['auth', 'clients', 'client-merge', 'requirements', 'job-portal', 'candidates', 'candidate-resumes', 'candidate-duplicates', 'doc-fill', 'rejections', 'applications',
      'followups', 'dashboard', 'reports', 'ats-reports', 'ats-daily', 'ats-report-pack', 'pending-work', 'ats', 'assistant', 'agent', 'insights', 'ats-io', 'tasks', 'agreement', 'offer-link',
      'messaging', 'conversations', 'recruiter-joinings', 'incentives', 'sourcing', 'approvals', 'masters', 'specialisations', 'positions', 'hrms', 'documents', 'announcements', 'helpdesk', 'followups', 'performance', 'projects'];
    const gets = listRoutes().filter((r) => r.method === 'GET' && PREFIXES.includes(r.path.split('/')[2]) && !/logout|download-all|backup|xlsx|export|\/file\b|\/pdf\b|stream|event/i.test(r.path));
    const app1 = await prisma.application.findFirst({ select: { id: true, candidateId: true, requirementId: true } });
    const idFor = (path, name) => {
      if (/^\/api\/clients/.test(path) || name === 'clientId') return client.id;
      if (/^\/api\/requirements|job-portal/.test(path) || name === 'requirementId') return jobOpen.id;
      if (/^\/api\/candidates|candidate-resumes|candidate-duplicates/.test(path) || name === 'candidateId') return app1 ? app1.candidateId : 'x';
      if (/^\/api\/applications/.test(path) || name === 'applicationId') return app1 ? app1.id : 'x';
      return client.id;
    };
    const urlOf = (p) => p.replace(/:([A-Za-z]+)/g, (m, n) => idFor(p, n));
    const urls = [...new Set(gets.map((r) => urlOf(r.path)))];
    if (LIST) { console.log(urls.join('\n')); }
    const POSTS = [
      ['/api/assistant/chat', { message: 'which clients have an unsigned agreement?', page: '/clients' }],
      ['/api/assistant/ask', { message: 'show agreement status of my clients', page: '/dashboard' }],
      ['/api/agent/chat', { message: 'agreement status', page: '/dashboard' }],
      ['/api/ats-io/export/clients?format=csv', { ids: [client.id] }],
      ['/api/ats-io/export/requirements?format=csv', {}],
      ['/api/ats-io/export/agreements?format=csv', {}],
      ['/api/ats-io/export/dashboard?format=csv', {}],
      ['/api/clients/check-duplicate', { name: client.name }],
    ];
    const results = {};
    const run = async (role) => {
      const found = new Map();
      const hit = (label, res) => {
        const l = leaksOf(res);
        if (l.length) found.set(label, l);
      };
      let n = 0;
      const queue = [...urls];
      const worker = async () => {
        while (queue.length) {
          const u = queue.shift(); n += 1;
          let res;
          const t0 = Date.now();
          try { res = await call('GET', u, tok[role]); } catch { continue; }
          if (Date.now() - t0 > 8000) console.log(`  slow ${Date.now() - t0}ms ${role} ${u.slice(0, 90)}`);
          hit(`GET ${u.replace(client.id, ':clientId').replace(jobOpen.id, ':reqId')} [${res.status}]`, res);
        }
      };
      await Promise.all([worker(), worker(), worker(), worker(), worker()]);
      for (const [p, body] of POSTS) {
        try { const res = await call('POST', p, tok[role], body); hit(`POST ${p} [${res.status}]`, res); } catch { /* skip */ }
      }
      results[role] = { found, n };
    };
    const ROLES = (process.env.AP_ROLES || 'admin,tl,stl,rec,hr').split(',').filter((r) => tok[r]); // AP_ROLES=none runs only the targeted checks
    for (const role of ROLES) { await run(role); console.log(`scanned ${results[role].n} GETs as ${role}: ${results[role].found.size} endpoints mention agreements`); }
    for (const role of ROLES.filter((r) => ['tl', 'stl', 'rec', 'hr'].includes(r))) {
      [...results[role].found].forEach(([label, l]) => console.log(`  LEAK ${role}  ${label}\n      ${l.slice(0, 6).join('\n      ')}`));
    }
    if (results.admin) check('CTRL the scanner finds agreement data for an Admin (so a clean result means something)', results.admin.found.size >= 3, results.admin.found.size);
    for (const role of ROLES.filter((r) => ['tl', 'stl', 'rec', 'hr'].includes(r))) check(`LEAK-FREE ${role}: no ATS endpoint mentions an agreement`, results[role].found.size === 0, [...results[role].found.keys()].slice(0, 12));
  } catch (e) {
    Z.fail += 1; console.error('TEST SCRIPT ERROR', (e && e.stack) || e);
  } finally {
    try {
      const left = await Z.cleanup();
      console.log('leftovers after cleanup:', JSON.stringify(left));
      Z.check('Z cleanup: nothing ZZTEST AP is left in the sandbox', Object.values(left).every((n) => n === 0), left);
    } catch (e) { console.error('cleanup problem:', e.message); }
    await Z.finish();
  }
})();
