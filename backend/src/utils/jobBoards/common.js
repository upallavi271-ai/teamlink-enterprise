// Shared bits of the job-board connectors: the Integrations config read and
// the job text every board gets. The client is never named on a public board:
// the advertiser is TeamLink Consultants (staffing).
const PUBLIC_COMPANY = 'TeamLink Consultants';

// Values of an Integrations card, decrypted, server side only
// (utils/integrationStore.readConfig). `need` = the labels that must be filled.
async function boardSettings(integrationId, need, label) {
  // eslint-disable-next-line global-require
  const { readConfig } = require('../integrationStore');
  const cfg = await readConfig(integrationId);
  const v = cfg.values || {};
  const filled = (k) => String(v[k] || '').trim() !== '';
  const anything = Object.keys(v).some(filled);
  if (cfg.row && cfg.row.connected === false && anything) {
    return { ready: false, off: true, configured: true, values: v, missing: ['the connection is switched off (press Reconnect)'], hint: `${label} is switched off in Administration → Integrations. Connect it again to post there.` };
  }
  if (cfg.missingKey) {
    return { ready: false, configured: true, values: v, missing: ['the saved secret could not be read (enter it again)'], hint: `A saved ${label} secret cannot be read on this server. Enter it again in Administration → Integrations → ${label}.` };
  }
  const missing = need.filter((k) => !filled(k));
  // configured = some arrangement was entered (then a gap is SETUP REQUIRED,
  // otherwise INTEGRATION REQUIRED — Save & Post, 2026-10-05).
  return { ready: missing.length === 0, configured: anything, values: v, missing };
}

const csv = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
function jobText(r) {
  return [
    r.jobDescription || r.description || '',
    r.responsibilities ? `Responsibilities:\n${r.responsibilities}` : '',
    r.qualifications ? `Qualifications:\n${r.qualifications}` : '',
    csv(r.skills).length ? `Skills: ${csv(r.skills).join(', ')}` : '',
    r.experience ? `Experience: ${r.experience}` : '',
  ].filter(Boolean).join('\n\n');
}

module.exports = { PUBLIC_COMPANY, boardSettings, jobText, csv };
