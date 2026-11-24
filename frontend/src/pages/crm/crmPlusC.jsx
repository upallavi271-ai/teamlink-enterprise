// ---------------------------------------------------------------------------
// CRM WAVE C - the shared pieces on the screen (2026-11-24): the set-up every form reads once (custom fields, layouts, currencies, business
// units, the financial year, branding), the custom-field inputs on a record's form, the layout applied to a form, a tag box, and the CRM
// words in Telugu / Hindi for the app's language switch. The rules are on the server (backend/src/crm/plusc/*.js).
// ---------------------------------------------------------------------------
import { useEffect, useState } from 'react';
import api from '../../api';
import { translations } from '../../i18n.jsx';

let setupCache = null; let setupAt = 0; let inflight = null;
const listeners = new Set();
export function loadSetup({ fresh = false } = {}) {
  if (!fresh && setupCache && Date.now() - setupAt < 60000) return Promise.resolve(setupCache);
  if (inflight && !fresh) return inflight;
  inflight = api.get('/crm/plusc/setup').then((r) => { setupCache = r.data; setupAt = Date.now(); inflight = null; listeners.forEach((f) => f(setupCache)); if (r.data.locale) setNumberLocale(r.data.locale.numbers); return setupCache; })
    .catch(() => { inflight = null; return setupCache || { fields: [], rules: [], objects: [], layouts: {}, builtIn: {}, currencies: [], units: [], fiscal: { startMonth: 4, holidays: [] }, locale: { numbers: 'en-IN' } }; });
  return inflight;
}
export function usePlusSetup() {
  const [s, setS] = useState(setupCache);
  useEffect(() => { listeners.add(setS); loadSetup().then(setS); return () => { listeners.delete(setS); }; }, []);
  return s;
}
export const refreshSetup = () => loadSetup({ fresh: true });

// the number format of the CRM's money (CRM settings > Customise > Currency & units): Indian lakh / crore, or international
let numberLocale = 'en-IN';
export function setNumberLocale(v) { numberLocale = ['en-IN', 'en-US', 'en-GB'].includes(v) ? v : 'en-IN'; }
export const getNumberLocale = () => numberLocale;

export const fieldsOfKind = (setup, kind) => ((setup && setup.fields) || []).filter((f) => f.kind === kind && f.active);
// a deal's money in its own currency: "$1,000 (₹84,000)"
export function foreignMoney(deal, setup) {
  if (!deal || !deal.currency || deal.currency === 'INR') return null;
  const c = ((setup && setup.currencies) || []).find((x) => x.code === deal.currency);
  const sym = c ? c.symbol : `${deal.currency} `;
  return `${sym}${Math.round(Number(deal.amountForeign) || 0).toLocaleString(numberLocale)}`;
}

// ---- the custom field inputs on a record form -------------------------------------------------------------------
export function CustomInput({ d, value, onChange, readOnly }) {
  const v = value == null ? '' : value;
  const common = { disabled: readOnly, 'aria-label': d.label };
  if (d.type === 'long') return <textarea rows={3} value={v} onChange={(e) => onChange(e.target.value)} {...common} />;
  if (d.type === 'select') return <select value={v} onChange={(e) => onChange(e.target.value)} {...common}><option value="">—</option>{d.options.map((o) => <option key={o} value={o}>{o}</option>)}</select>;
  if (d.type === 'multi') {
    const list = Array.isArray(v) ? v : String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px' }}>
        {d.options.map((o) => (
          <label key={o} style={{ display: 'inline-flex', gap: 4, alignItems: 'center', fontWeight: 500, margin: 0 }}>
            <input type="checkbox" style={{ width: 'auto' }} disabled={readOnly} checked={list.includes(o)} onChange={(e) => onChange(e.target.checked ? [...list, o] : list.filter((x) => x !== o))} /> {o}
          </label>
        ))}
      </div>
    );
  }
  if (d.type === 'checkbox') return <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontWeight: 500, margin: 0 }}><input type="checkbox" style={{ width: 'auto' }} checked={v === true || v === 'true'} onChange={(e) => onChange(e.target.checked)} {...common} /> Yes</label>;
  const type = { number: 'number', date: 'date', email: 'email', phone: 'tel', url: 'url' }[d.type] || 'text';
  return <input type={type} value={v} onChange={(e) => onChange(e.target.value)} placeholder={d.sensitive ? 'Kept encrypted' : undefined} {...common} />;
}

// ---- a form laid out by the layout (CRM settings > Customise > Layouts) ---------------------------------------------
// fields: the form's own list [{ k, label, ... }]; returns [{ name, fields: [...] }] with the custom fields in, hidden ones out
export function applyLayout(kind, fields, setup, role) {
  const custom = fieldsOfKind(setup, kind).map((d) => ({ k: d.key, label: `${d.label}${d.required ? ' *' : ''}`, custom: d, hint: d.helpText || (d.sensitive ? 'Kept encrypted; others see it masked' : undefined), wide: d.type === 'long' || d.type === 'multi', section: d.section }));
  const all = [...fields, ...custom];
  const L = (setup && setup.layouts && setup.layouts[kind]) || null;
  const roleKey = role === 'view' ? 'viewer' : role === 'tl' ? 'manager' : role === 'bde' || role === 'bdeAll' ? 'rep' : null;
  const hidden = new Set(L && roleKey && L.hidden ? (L.hidden[roleKey] || []) : []);
  const readOnly = new Set(L && roleKey === 'rep' && L.readOnly ? (L.readOnly.rep || []) : []);
  const visible = all.filter((f) => !hidden.has(f.k) || /\*/.test(f.label)).map((f) => (readOnly.has(f.k) ? { ...f, readOnly: true, hint: f.hint || 'Set by a Sales manager' } : f));
  if (!L || !L.sections || !L.sections.length) {
    // no layout: the standard form, then the custom fields grouped by their own section
    const bySection = new Map();
    visible.filter((f) => f.custom).forEach((f) => { const s = f.section || 'More details'; if (!bySection.has(s)) bySection.set(s, []); bySection.get(s).push(f); });
    return [{ name: '', fields: visible.filter((f) => !f.custom) }, ...[...bySection.entries()].map(([name, list]) => ({ name, fields: list }))];
  }
  const placed = new Set();
  const sections = L.sections.map((s) => ({ name: s.name, fields: s.fields.map((k) => visible.find((f) => f.k === k)).filter((f) => f && !placed.has(f.k) && placed.add(f.k)) })).filter((s) => s.fields.length);
  const rest = visible.filter((f) => !placed.has(f.k));
  if (rest.length) sections.push({ name: 'Other details', fields: rest });
  return sections;
}

// ---- a tag box: comma-separated tags, with the ones already in use offered ------------------------------------------
export function TagInput({ value, onChange, kind, disabled }) {
  const [known, setKnown] = useState([]);
  useEffect(() => { api.get('/crm/plusc/tags', { params: { kind } }).then((r) => setKnown(r.data.tags || [])).catch(() => setKnown([])); }, [kind]);
  const list = String(value || '').split(',').map((x) => x.trim()).filter(Boolean);
  const id = `tags-${kind}`;
  return (
    <>
      <input type="text" value={value || ''} onChange={(e) => onChange(e.target.value)} list={id} placeholder="e.g. VIP, Expo 2026" disabled={disabled} aria-label="Tags" />
      <datalist id={id}>{known.filter((t) => !list.some((x) => x.toLowerCase() === t.tag.toLowerCase())).slice(0, 40).map((t) => <option key={t.tag} value={[...list, t.tag].join(', ')}>{t.tag}</option>)}</datalist>
    </>
  );
}
export const TagChips = ({ tags }) => {
  const list = Array.isArray(tags) ? tags : String(tags || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!list.length) return null;
  return <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>{list.map((t) => <span key={t} className="status review" style={{ fontWeight: 600 }}>#{t}</span>)}</span>;
};

// ---- the CRM's words in Telugu and Hindi (17.06): added to the app's own dictionary (i18n.jsx), used through t() ----------
const CRM_TE = {
  'Sales Dashboard': 'సేల్స్ డాష్‌బోర్డ్', Leads: 'లీడ్స్', Deals: 'డీల్స్', 'Accounts & Contacts': 'ఖాతాలు & కాంటాక్ట్‌లు', Accounts: 'ఖాతాలు', Contacts: 'కాంటాక్ట్‌లు',
  'Support tickets': 'సపోర్ట్ టికెట్లు', 'More records': 'మరిన్ని రికార్డులు', 'Customer health': 'కస్టమర్ ఆరోగ్యం', 'Data care': 'డేటా సంరక్షణ', Overview: 'సారాంశం', Activities: 'కార్యకలాపాలు',
  Notes: 'నోట్స్', Proposals: 'ప్రతిపాదనలు', Invoice: 'ఇన్వాయిస్', More: 'మరిన్ని', Privacy: 'గోప్యత', Conversation: 'సంభాషణ', '+ Lead': '+ లీడ్', '+ Deal': '+ డీల్', '+ Account': '+ ఖాతా', '+ Contact': '+ కాంటాక్ట్',
  Merge: 'కలుపు', Tags: 'ట్యాగ్‌లు', Files: 'ఫైళ్లు', 'Recycle bin': 'రీసైకిల్ బిన్', Adoption: 'వినియోగం', 'Customise the CRM': 'CRM ను మార్చు', Download: 'డౌన్‌లోడ్', Search: 'వెతుకు', Restore: 'తిరిగి పెట్టు',
  'Lead record': 'లీడ్ రికార్డ్', 'Deal record': 'డీల్ రికార్డ్', 'Customer record': 'కస్టమర్ రికార్డ్', Consent: 'సమ్మతి', 'Account team': 'ఖాతా బృందం', 'Org chart': 'సంస్థ చార్ట్', 'Parent company': 'మాతృ సంస్థ',
};
const CRM_HI = {
  'Sales Dashboard': 'सेल्स डैशबोर्ड', Leads: 'लीड्स', Deals: 'डील्स', 'Accounts & Contacts': 'खाते और संपर्क', Accounts: 'खाते', Contacts: 'संपर्क',
  'Support tickets': 'सपोर्ट टिकट', 'More records': 'और रिकॉर्ड', 'Customer health': 'ग्राहक स्वास्थ्य', 'Data care': 'डेटा देखभाल', Overview: 'सारांश', Activities: 'गतिविधियाँ',
  Notes: 'नोट्स', Proposals: 'प्रस्ताव', Invoice: 'इनवॉइस', More: 'और', Privacy: 'गोपनीयता', Conversation: 'बातचीत', '+ Lead': '+ लीड', '+ Deal': '+ डील', '+ Account': '+ खाता', '+ Contact': '+ संपर्क',
  Merge: 'मिलाएँ', Tags: 'टैग', Files: 'फ़ाइलें', 'Recycle bin': 'रीसायकल बिन', Adoption: 'उपयोग', 'Customise the CRM': 'CRM बदलें', Download: 'डाउनलोड', Search: 'खोजें', Restore: 'वापस लाएँ',
  'Lead record': 'लीड रिकॉर्ड', 'Deal record': 'डील रिकॉर्ड', 'Customer record': 'ग्राहक रिकॉर्ड', Consent: 'सहमति', 'Account team': 'खाता टीम', 'Org chart': 'संगठन चार्ट', 'Parent company': 'मूल कंपनी',
};
if (translations && translations.te) Object.keys(CRM_TE).forEach((k) => { if (!(k in translations.te)) translations.te[k] = CRM_TE[k]; });
if (translations && translations.hi) Object.keys(CRM_HI).forEach((k) => { if (!(k in translations.hi)) translations.hi[k] = CRM_HI[k]; });

export const fmtBytes = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
