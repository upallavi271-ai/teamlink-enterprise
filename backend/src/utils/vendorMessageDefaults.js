// ---------------------------------------------------------------------------
// VENDOR PORTAL EMAILS - starter wording for the Message templates hub (Administration -> Company Setup -> Message templates, "Vendors").
// Read by utils/messageDefaults.js; an Admin edits it there (a saved edit always wins over these words).
//
//   VENDOR_WELCOME        the welcome email a vendor gets when Admin creates (or re-sends) their login: login ID, a TEMPORARY password
//                         (expires with the invitation; the vendor must choose their own at the first sign-in), the Vendor Portal address
//                         and a secure link to set their own password. Never a permanent password.
//   VENDOR_PASSWORD_RESET the email for "Forgot password" (vendor) or "Send password reset" (Admin): a secure link, works once.
//   VENDOR_EMAIL_VERIFY   goes to the NEW address when Admin changes the email of an active vendor: the change counts only after the vendor
//                         opens the link; until then the old email keeps working.
//
// The details ({{setupLink}} and the rest) are filled by utils/vendorMail.js. The secure link detail is required: the editor refuses wording
// without it (utils/messageTemplates.js REQUIRED_TOKENS).
// ---------------------------------------------------------------------------
const ROWS = [
  {
    purpose: 'VENDOR_WELCOME', label: 'Vendor welcome and password setup', audience: 'vendor', channels: ['Email'],
    subject: 'Welcome to the {{company}} Vendor Portal: set up your login',
    body: [
      'Hello {{name}},',
      '',
      'Welcome to the {{company}} Vendor Portal. A login has been created for {{vendorCompany}}.',
      '',
      'Your login ID: {{loginId}}',
      'Temporary password: {{tempPassword}}',
      'Vendor Portal: {{portalUrl}}',
      '',
      'This is invitation number {{attemptNo}}, sent on {{sentAt}}. Use only the newest email we send you: when we send a new one, the older passwords and links stop working.',
      'Type the login ID and the password exactly as shown (no spaces). Copy only what is inside each box.',
      '',
      'Option 1. Sign in at the Vendor Portal with your login ID and the temporary password above. You will be asked to choose your own password straight away.',
      'Option 2. Or set your own password first with this secure link:',
      '{{setupLink}}',
      '',
      'The temporary password and the link both stop working on {{expiresOn}} ({{expiryText}} from now), and the link works only once. After that, ask us to send a new invitation. If you forget your password later, use "Forgot password" on the Vendor Portal sign-in page.',
      '',
      'Please do not share this email with anyone. This temporary password is only for your first sign-in; we never send a permanent password.',
      'If you did not expect this email, please ignore it and tell us.',
      '',
      'Need help? {{supportLine}}',
      '',
      'Thank you,',
      '{{company}}',
    ].join('\n'),
  },
  {
    purpose: 'VENDOR_PASSWORD_RESET', label: 'Vendor password reset', audience: 'vendor', channels: ['Email'],
    subject: 'Reset your {{company}} Vendor Portal password',
    body: [
      'Hello {{name}},',
      '',
      'We received a request to reset the password for your {{company}} Vendor Portal login.',
      '',
      'Your login ID: {{loginId}}',
      'Vendor Portal: {{portalUrl}}',
      '',
      'Choose a new password with this secure link:',
      '{{setupLink}}',
      '',
      'The link works only once and stops working on {{expiresOn}} ({{expiryText}} from now).',
      'Your old password keeps working until you choose a new one.',
      '',
      'If you did not ask for this, you can ignore this email. Your password will not change unless the link is opened.',
      '',
      'Need help? {{supportLine}}',
      '',
      'Thank you,',
      '{{company}}',
    ].join('\n'),
  },
  {
    purpose: 'VENDOR_EMAIL_VERIFY', label: 'Vendor new email address: please confirm', audience: 'vendor', channels: ['Email'],
    subject: 'Please confirm your new {{company}} Vendor Portal email',
    body: [
      'Hello {{name}},',
      '',
      'The email address for your {{company}} Vendor Portal login ({{vendorCompany}}) is being changed to this address: {{newEmail}}.',
      '',
      'To finish the change, confirm it with this secure link:',
      '{{setupLink}}',
      '',
      'The link works only once and stops working on {{expiresOn}} ({{expiryText}} from now).',
      'Until you confirm, you keep signing in with your old email ({{loginId}}). After you confirm, your login ID becomes {{newEmail}} and your password stays the same.',
      '',
      'If you did not expect this, ignore this email. Nothing changes unless the link is opened.',
      '',
      'Need help? {{supportLine}}',
      '',
      'Thank you,',
      '{{company}}',
    ].join('\n'),
  },
  {
    purpose: 'VENDOR_EMAIL_CHANGED', label: 'Vendor login email changed (to the old address)', audience: 'vendor', channels: ['Email'],
    subject: 'Your {{company}} Vendor Portal login email was changed',
    body: [
      'Hello {{name}},',
      '',
      'The login email of your {{company}} Vendor Portal account ({{vendorCompany}}) was changed.',
      '',
      'Old login ID: {{loginId}}',
      'New login ID: {{newEmail}}',
      '',
      'The change was confirmed by opening a link sent to the new address. Your password has not changed. From now on sign in with the new login ID at {{portalUrl}}.',
      '',
      'If this was not you or you did not expect it, please contact us right away. {{supportLine}}',
      '',
      'Thank you,',
      '{{company}}',
    ].join('\n'),
  },
];

function list() {
  const out = [];
  ROWS.forEach((r) => r.channels.forEach((channel) => out.push({
    purpose: r.purpose, label: r.label, audience: r.audience, channel, language: 'English', subject: r.subject, body: r.body,
  })));
  return out;
}

const find = (purpose, channel) => ROWS.find((r) => r.purpose === purpose && r.channels.includes(channel)) || null;

module.exports = { list, find, ROWS };
