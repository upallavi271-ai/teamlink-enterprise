// Item 7: partner / vendor logins hand out one-time links, never a password.
module.exports = async function secPartners({ check, call, mkUser, mint, made, prisma, RUN }) {
  console.log('\n--- 7: partner / vendor login links ---');
  const ids = { partner: null, vendor: null, puIds: [], vuIds: [] };
  made.extra.push(async () => {
    await prisma.partnerSession.deleteMany({ where: { partnerUserId: { in: ids.puIds } } }).catch(() => {});
    await prisma.partnerUser.deleteMany({ where: { id: { in: ids.puIds } } }).catch(() => {});
    if (ids.partner) await prisma.partner.deleteMany({ where: { id: ids.partner } }).catch(() => {});
    await prisma.vendorLoginToken.deleteMany({ where: { vendorUserId: { in: ids.vuIds } } }).catch(() => {});
    await prisma.vendorSession.deleteMany({ where: { vendorUserId: { in: ids.vuIds } } }).catch(() => {});
    await prisma.vendorUser.deleteMany({ where: { id: { in: ids.vuIds } } }).catch(() => {});
    if (ids.vendor) await prisma.officeVendor.deleteMany({ where: { id: ids.vendor } }).catch(() => {});
  });
  const adm = await mkUser('PAdmin', { role: 'ADMIN', hrmsRole: 'ADMIN', atsRole: 'ADMIN', accountsRole: 'ADMIN', atsAccess: true, accountsAccess: true }, { designation: 'Admin' });
  const sa = await mkUser('PSA', { role: 'SUPER_ADMIN', hrmsRole: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN', accountsRole: 'SUPER_ADMIN', atsAccess: true, accountsAccess: true }, { designation: 'Super Admin' });
  const T = await mint(adm.u);
  const partner = await prisma.partner.create({ data: { name: `ZZTEST Sec Partner ${RUN}`, type: 'Agency', status: 'Active' } });
  ids.partner = partner.id;
  const email = `zz-sec-partner-${RUN}@example.test`;
  const NOPW = (r) => !/"tempPassword"\s*:|"password"\s*:|passwordHash/i.test(String(r.text || ''));

  // ---- partner create
  let r = await call('POST', '/api/partners/logins', T, { partnerId: partner.id, name: 'ZZTEST Sec Partner Person', email, autoPassword: true });
  check('partner create answers 201', r.status === 201, `${r.status} ${r.text.slice(0, 160)}`);
  if (r.body && r.body.login) ids.puIds.push(r.body.login.id);
  check('partner create returns a one-time link, not a password', !!(r.body && r.body.inviteLink && /partner-login\?invite=/.test(r.body.inviteLink)) && NOPW(r), r.text.slice(0, 200));
  r = await call('POST', '/api/partners/logins', T, { partnerId: partner.id, name: 'ZZTEST Sec Partner Typed', email: `zz-sec-partner2-${RUN}@example.test`, password: 'Typed-Password-123!x' });
  if (r.body && r.body.login) ids.puIds.push(r.body.login.id);
  check('a typed password is ignored and never echoed (link only)', r.status === 201 && !!r.body.inviteLink && !r.text.includes('Typed-Password-123'), r.text.slice(0, 160));
  const first = (await call('POST', '/api/partners/logins', T, { partnerId: partner.id, name: 'ZZTEST Sec Partner Three', email: `zz-sec-partner3-${RUN}@example.test` }));
  if (first.body && first.body.login) ids.puIds.push(first.body.login.id);
  const link1 = first.body.inviteLink; const tok1 = decodeURIComponent(link1.split('invite=')[1]);
  const puId = first.body.login.id;
  const dbPu = await prisma.partnerUser.findUnique({ where: { id: puId } });
  check('the stored password is random (mustChangePassword on, no known password)', dbPu.mustChangePassword === true && /^\$2[aby]\$/.test(dbPu.passwordHash));
  // link check + accept
  let g = await call('GET', `/api/partner-portal/invite/${encodeURIComponent(tok1)}`);
  check('the link opens (valid, shows partner name, no secrets)', g.status === 200 && g.body.valid === true && g.body.email && !/hash|token/i.test(JSON.stringify(Object.keys(g.body))), g.text.slice(0, 160));
  g = await call('GET', `/api/partner-portal/invite/${encodeURIComponent(`${tok1.slice(0, -4)}AAAA`)}`);
  check('a forged link is refused', g.status === 404, g.status);
  const [body, sig] = tok1.split('.');
  const tampered = `${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), e: Date.now() + 9e9 })).toString('base64url')}.${sig}`;
  g = await call('GET', `/api/partner-portal/invite/${encodeURIComponent(tampered)}`);
  check('a link with a longer expiry written in is refused (signature)', g.status === 404, g.status);
  let a = await call('POST', '/api/partner-portal/invite/accept', undefined, { token: tok1, newPassword: 'short', confirmPassword: 'short' });
  check('a weak password is refused and the link survives', a.status === 400 && a.body.field === 'newPassword', a.text.slice(0, 120));
  const NEWPW = `Zz-Partner-${RUN}-Strong!9`;
  a = await call('POST', '/api/partner-portal/invite/accept', undefined, { token: tok1, newPassword: NEWPW, confirmPassword: NEWPW });
  check('the partner chooses a password and is signed in', a.status === 200 && !!a.body.token && a.body.partner && a.body.partner.mustChangePassword === false, a.text.slice(0, 160));
  a = await call('POST', '/api/partner-portal/invite/accept', undefined, { token: tok1, newPassword: `${NEWPW}x`, confirmPassword: `${NEWPW}x` });
  check('the link works only once', a.status === 400 && a.body.linkProblem === true, a.status);
  let lg = await call('POST', '/api/partner-portal/login', undefined, { email: `zz-sec-partner3-${RUN}@example.test`, password: NEWPW });
  check('signing in with the chosen password works', lg.status === 200 && !!lg.body.token, lg.status);

  // ---- partner reset
  const rs = await call('POST', `/api/partners/logins/${puId}/reset-password`, T, {});
  check('partner reset returns a link, not a password', rs.status === 200 && !!rs.body.inviteLink && NOPW(rs), rs.text.slice(0, 160));
  lg = await call('POST', '/api/partner-portal/login', undefined, { email: `zz-sec-partner3-${RUN}@example.test`, password: NEWPW });
  check('after a reset the old password no longer works', lg.status === 401, lg.status);
  const tok2 = decodeURIComponent(rs.body.inviteLink.split('invite=')[1]);
  const rs2 = await call('POST', `/api/partners/logins/${puId}/reset-password`, T, {});
  g = await call('GET', `/api/partner-portal/invite/${encodeURIComponent(tok2)}`);
  check('making a newer link kills the older one', g.status === 404, g.status);
  const tok3 = decodeURIComponent(rs2.body.inviteLink.split('invite=')[1]);
  a = await call('POST', '/api/partner-portal/invite/accept', undefined, { token: tok3, newPassword: `${NEWPW}2`, confirmPassword: `${NEWPW}2` });
  check('the newest reset link works', a.status === 200, a.status);
  const alert = await prisma.notification.findFirst({ where: { title: { contains: 'Partner' }, message: { contains: 'ZZTEST Sec Partner' } }, orderBy: { createdAt: 'desc' } });
  check('an alert about the partner link exists for the overall-access people and carries no link', !!alert && !/invite=|http/i.test(alert.message), alert && alert.message);
  // the audit rows carry no secret
  const aud = await prisma.auditLog.findMany({ where: { entityId: puId }, select: { toValue: true, action: true } });
  check('the audit rows carry no link / password', !JSON.stringify(aud).match(/invite=|Zz-Partner/), aud.length);

  // ---- vendor
  const vendor = await prisma.officeVendor.create({ data: { name: `ZZTEST Sec Vendor ${RUN}` } });
  ids.vendor = vendor.id;
  // DATA: the founder has switched Vendor emails ON in the real database; this section is about the default (emails OFF: the link is shown to pass on by hand). The saved value is put back below.
  const emailsBefore = await prisma.appSetting.findUnique({ where: { key: 'vendorPortal.settings' } });
  await prisma.appSetting.upsert({ where: { key: 'vendorPortal.settings' }, update: { value: JSON.stringify({ emailsEnabled: false }) }, create: { key: 'vendorPortal.settings', value: JSON.stringify({ emailsEnabled: false }) } });
  let v = await call('POST', '/api/vendor-logins', T, { vendorId: vendor.id, name: 'ZZTEST Sec Vendor Person', email: `zz-sec-vendor-${RUN}@example.test`, autoPassword: true });
  if (v.body && v.body.login) ids.vuIds.push(v.body.login.id);
  check('vendor create (even with autoPassword) returns a link, not a password', v.status === 201 && !!v.body.inviteLink && NOPW(v), `${v.status} ${v.text.slice(0, 160)}`);
  const vId = v.body.login && v.body.login.id;
  v = await call('POST', `/api/vendor-logins/${vId}/reset-password`, T, {});
  check('vendor reset returns a link, not a password', v.status === 200 && !!v.body.inviteLink && NOPW(v), `${v.status} ${v.text.slice(0, 160)}`);
  v = await call('POST', `/api/vendor-logins/${vId}/reset-password`, T, { autoPassword: true });
  check('vendor reset with autoPassword still returns a link', v.status === 200 && !!v.body.inviteLink && NOPW(v), v.status);
  if (emailsBefore) await prisma.appSetting.update({ where: { key: 'vendorPortal.settings' }, data: { value: emailsBefore.value } }); else await prisma.appSetting.deleteMany({ where: { key: 'vendorPortal.settings' } });
};
