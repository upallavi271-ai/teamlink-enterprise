// ---------------------------------------------------------------------------
// CRM > AI SIGNALS (wave E, 2026-11-24; gaps 09.05, 09.10, 09.12, 09.13, 14.04).
//
//   SENTIMENT / INTENT   the tone of what a customer said (their replies, call outcomes, meeting notes): Positive / Neutral / Negative,
//                        and what they want (meeting, details, price concern, complaint, not interested, later, ready). Worked out by code
//                        (English + common Telugu / Hindi words in English letters) on every record; "Ask the AI" re-reads the last lines.
//   FIELDS FROM TEXT     a pasted mail / signature / call note, or a photo of a visiting card (OCR, utils/resumeOcr.js), becomes lead
//                        fields. Code finds phone, email, website, GSTIN, pincode, city, company, designation and the name; the AI (when
//                        set up) may only fill a field with words that are really in the text. For a record already there: only EMPTY
//                        fields are suggested, and nothing is saved until the person presses Apply.
//   UNUSUAL CHANGES      last week against the 8 weeks before (leads in, calls / meetings / mails logged, deals won and lost, follow-ups
//                        done; per salesperson for managers): a big rise or fall is told in one plain line. The Monday bell to the Sales
//                        managers is OFF until an Admin turns it on (crm/plus.js anomalyAlerts).
//   CALL SUMMARIES       the recorded browser calls (browsercall/recording.js: transcript + summary) to any phone number of a lead / deal /
//                        account are listed on the record, and "Add to timeline" writes the summary there; a salesperson's own call notes
//                        or a pasted transcript become a short summary + next step, saved as the call on the timeline.
// AI goes through utils/fastAi.js (masked by the AI governance wrapper); every part has a code answer when no AI is set up.
// ---------------------------------------------------------------------------
const P = require('./plusE');
const S = require('./service');
const DB = require('./schema');

const clip = (v, n) => S.clip(v, n);

// ---- 1. sentiment / intent -------------------------------------------------------------------------------------------------------
const NEG = ['not interested', 'no interest', 'not required', 'no requirement', 'no requirements', 'no need', "don't call", 'do not call', 'dont call', 'stop calling', 'unsubscribe', 'too expensive', 'expensive', 'costly', 'too high', 'high fee', 'no budget', 'complaint', 'unhappy', 'not happy', 'angry', 'worst', 'very bad', 'poor service', 'disappointed', 'waste', 'cancel', 'not satisfied', 'already have a vendor', 'another agency', 'other vendor', 'vaddu', 'avasaram ledu', 'nahi chahiye', 'mat karo', 'not now', 'busy'];
const POS = ['interested', 'great', 'good', 'thanks', 'thank you', 'sure', 'agree', 'agreed', 'happy', 'perfect', 'excellent', 'send the proposal', 'send details', 'share details', 'share the details', 'go ahead', 'confirmed', 'confirm', "let's meet", 'let us meet', 'call me', 'looking forward', 'need candidates', 'urgent requirement', 'hiring', 'kavali', 'chahiye', 'haan', 'avunu', 'spoke', 'meeting held', 'yes'];
const INTENTS = [
  ['Not interested', /not interested|no (interest|requirement|need)|not required|do ?n[o']?t call|stop calling|unsubscribe|vaddu|avasaram ledu|nahi chahiye/],
  ['Complaint', /complain|unhappy|not happy|angry|worst|disappointed|poor service|not satisfied|very bad/],
  ['Price concern', /expensive|costly|too high|high fee|discount|budget|reduce the (fee|price)|price is high|rate is high|negotiat/],
  ['Ready to go ahead', /go ahead|confirmed|sign(ed)? the agreement|purchase order|\bpo\b|start (from|on|next)|we agree|finali[sz]ed/],
  ['Wants a meeting', /meet(ing)?|call me|schedule|demo|visit (us|our)|catch up/],
  ['Asks for details', /details|proposal|quote|quotation|brochure|profile|send (me|us)|share (the )?(deck|profile|rates)|rate card/],
  ['Later', /later|next (month|quarter|year|week)|after (diwali|sankranti|the festival|march|april)|busy|not now|call back/],
];
const SKIP = /^(Stage:|Follow-up moved:|Invoice |Payment of |Discount |Proposal .* (sent|created)|Email sent|WhatsApp sent|SMS sent|Mail app opened|WhatsApp opened|Call through TeamLink|Field visit: checked in)/;
function sentimentOf(text) {
  let t = ` ${String(text || '').toLowerCase().replace(/\s+/g, ' ')} `;
  if (!t.trim()) return null;
  let neg = 0; let pos = 0;
  NEG.forEach((w) => { if (t.includes(w)) { neg += w.includes(' ') ? 2 : 1; t = t.split(w).join(' '); } }); // a negative phrase is taken out first ("not interested" is not "interested")
  POS.forEach((w) => { if (new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\']/g, '\\$&')}\\b`).test(t)) pos += w.includes(' ') ? 2 : 1; });
  const full = String(text || '').toLowerCase();
  const intent = (INTENTS.find(([, re]) => re.test(full)) || [null])[0];
  const score = (pos - neg) / Math.max(1, pos + neg);
  const label = intent === 'Not interested' || intent === 'Complaint' ? 'Negative' : score >= 0.3 ? 'Positive' : score <= -0.3 ? 'Negative' : 'Neutral';
  return { label, score: Math.round(score * 100) / 100, intent };
}
// the lines that are what the CUSTOMER said or how a contact went (not our own sends, not system lines)
const theirs = (a) => !SKIP.test(String(a.subject || '')) && (a.note || /^Replied on |^Call outcome|^Call summary|^Recorded call/.test(String(a.subject || ''))) && ['call', 'meeting', 'email', 'whatsapp', 'note'].includes(a.kind);
function moodOf(items) {
  const scored = items.filter((x) => x.sentiment);
  if (!scored.length) return { label: 'Not known yet', score: null, trend: null, intent: null };
  let w = 0; let s = 0;
  scored.slice(0, 6).forEach((x, i) => { const k = 1 / (i + 1); w += k; s += k * (x.sentiment.label === 'Positive' ? 1 : x.sentiment.label === 'Negative' ? -1 : 0); });
  const score = s / w;
  const first = scored[0].sentiment.label; const older = scored.slice(1, 4).map((x) => x.sentiment.label);
  const val = (l) => (l === 'Positive' ? 1 : l === 'Negative' ? -1 : 0);
  const avgOld = older.length ? older.reduce((a, l) => a + val(l), 0) / older.length : null;
  const trend = avgOld == null ? null : val(first) > avgOld + 0.3 ? 'warming up' : val(first) < avgOld - 0.3 ? 'cooling down' : 'steady';
  return { label: score >= 0.3 ? 'Positive' : score <= -0.3 ? 'Negative' : 'Neutral', score: Math.round(score * 100) / 100, trend, intent: (scored.find((x) => x.sentiment.intent) || { sentiment: {} }).sentiment.intent || null };
}
async function sentiment(user, kind, id, { ai } = {}) {
  const r = await P.readable(user, kind, id);
  if (r.error) return r.error;
  const col = { lead: 'leadId', deal: 'dealId', account: 'accountId', contact: 'contactId' }[kind];
  const acts = await DB.all(`SELECT "id", "kind", "subject", "note", "at", "byName" FROM "CrmActivity" WHERE "${col}" = ? ORDER BY "at" DESC LIMIT 60`, r.row.id);
  const items = acts.filter(theirs).map((a) => ({ id: a.id, at: a.at, kind: a.kind, subject: a.subject, sentiment: sentimentOf(`${a.subject || ''}. ${a.note || ''}`), by: 'code' }));
  let aiNote = null;
  if (ai && items.length) {
    try {
      const fa = require('../utils/fastAi'); // eslint-disable-line global-require
      const list = items.slice(0, 8).map((x, i) => `${i + 1}. [${x.kind}] ${clip(x.subject, 120) || ''} ${clip((acts.find((a) => a.id === x.id) || {}).note, 400) || ''}`).join('\n');
      const res = await fa.chat('You read sales CRM timeline lines of a recruitment company in India (they may mix English, Telugu and Hindi). For each line say the CUSTOMER\'s tone and intent. Reply ONLY as JSON: {"items":[{"n":1,"label":"Positive|Neutral|Negative","intent":"Wants a meeting|Asks for details|Price concern|Complaint|Not interested|Later|Ready to go ahead|none"}]}', [{ role: 'user', content: list }], { json: true, maxTokens: 500, purpose: 'CRM sentiment' });
      const j = require('../utils/ai').parseJsonLoose(res.text); // eslint-disable-line global-require
      (j && Array.isArray(j.items) ? j.items : []).forEach((y) => {
        const x = items[Number(y.n) - 1];
        if (x && ['Positive', 'Neutral', 'Negative'].includes(y.label)) x.sentiment = { ...x.sentiment, label: y.label, intent: y.intent && y.intent !== 'none' ? clip(y.intent, 40) : x.sentiment.intent }, x.by = res.provider || 'AI';
      });
      aiNote = res.provider || 'AI';
    } catch (e) { aiNote = `The AI could not read it now (${clip(e.message, 80)}); the code reading is shown.`; }
  }
  return S.okBody({ mood: moodOf(items), items: items.slice(0, 20), ai: aiNote });
}

// ---- 2. fields from text / a card -----------------------------------------------------------------------------------------------
const CITIES = ['Hyderabad', 'Secunderabad', 'Bengaluru', 'Bangalore', 'Chennai', 'Mumbai', 'Navi Mumbai', 'Thane', 'Pune', 'New Delhi', 'Delhi', 'Noida', 'Gurugram', 'Gurgaon', 'Kolkata', 'Ahmedabad', 'Vijayawada', 'Visakhapatnam', 'Vizag', 'Warangal', 'Coimbatore', 'Kochi', 'Jaipur', 'Lucknow', 'Chandigarh', 'Indore', 'Nagpur', 'Bhubaneswar', 'Mysuru', 'Mysore', 'Guntur', 'Tirupati', 'Nellore', 'Kakinada', 'Rajahmundry', 'Karimnagar', 'Nizamabad', 'Surat', 'Vadodara', 'Madurai', 'Trivandrum', 'Thiruvananthapuram', 'Bhopal', 'Patna', 'Ranchi'];
const INDUSTRY = [['IT / Software', /software|technolog|\bit services|infotech|systems|digital|cloud|saas|\btech\b/], ['Healthcare', /hospital|clinic|health|pharma|diagnostic|medical/], ['Education', /school|college|university|academy|institute|education|edtech/], ['Manufacturing', /manufactur|industries|engineering|plant|factory|steel|cement|auto ?components/], ['Banking / Finance', /bank|finance|financial|insurance|nbfc|capital|securities/], ['Retail', /retail|store|mart|supermarket|fashion/], ['Logistics', /logistic|transport|courier|shipping|supply chain/], ['Construction / Real estate', /construction|infra|builders|real estate|realty|developers/], ['Hospitality', /hotel|resort|restaurant|hospitality/]];
const CO_WORDS = /\b(pvt|private|ltd|limited|llp|inc|corp|corporation|technologies|technology|solutions|services|consultants|consulting|industries|enterprises|group|systems|labs|hospitals?|school|college|academy|infotech|software|pharma|foods|motors|exports|traders)\b/i;
const DESIG = /\b(manager|director|head|hr|human resources|ceo|cto|cfo|coo|founder|co-founder|owner|partner|lead|executive|officer|president|vp|vice president|recruiter|talent|admin|engineer|consultant|analyst|proprietor|principal|chairman|md|gm|agm|dgm|associate|coordinator|specialist)\b/i;
const FREE_MAIL = /@(gmail|yahoo|outlook|hotmail|rediffmail|live|icloud|proton)\./i;
const titleCase = (s) => s.replace(/\b([a-z])([a-z]*)/gi, (m, a, b) => a.toUpperCase() + b.toLowerCase());
function moneyIn(text) {
  const t = String(text || '');
  const lakh = /(?:₹|rs\.?|inr)?\s*(\d+(?:\.\d+)?)\s*(lakh|lakhs|lac|lacs|l\b|crore|cr\b|k\b|thousand)/i.exec(t);
  if (lakh) { const n = Number(lakh[1]); const u = lakh[2].toLowerCase(); return Math.round(n * (/^c/.test(u) ? 1e7 : /^(k|t)/.test(u) ? 1e3 : 1e5)); }
  const rs = /(?:₹|rs\.?|inr)\s*([\d,]{4,})(?:\.\d+)?/i.exec(t);
  return rs ? Number(rs[1].replace(/,/g, '')) : null;
}
function dateIn(text, today = S.istToday()) {
  const t = String(text || '').toLowerCase();
  const add = (n) => S.addDaysIso ? S.addDaysIso(today, n) : new Date(Date.parse(`${today}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  const iso = /\b(20\d{2})-(\d{2})-(\d{2})\b/.exec(t); if (iso) return iso[0];
  const dmy = /\b(\d{1,2})[/.-](\d{1,2})[/.-](20\d{2})\b/.exec(t); if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const dm = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/.exec(t);
  if (dm) { const mo = MON.indexOf(dm[2]) + 1; let y = Number(today.slice(0, 4)); const c = `${y}-${String(mo).padStart(2, '0')}-${dm[1].padStart(2, '0')}`; if (c < today) y += 1; return `${y}-${String(mo).padStart(2, '0')}-${dm[1].padStart(2, '0')}`; }
  if (/\btomorrow\b|\brepu\b|\bkal\b/.test(t)) return add(1);
  if (/\bday after tomorrow\b/.test(t)) return add(2);
  const inN = /\bin (\d{1,2}) days?\b/.exec(t); if (inN) return add(Number(inN[1]));
  if (/\bnext week\b/.test(t)) return add(7);
  if (/\bnext month\b/.test(t)) return add(30);
  const DOW = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const dw = DOW.findIndex((d) => new RegExp(`\\b(on |next |this )?${d}\\b`).test(t));
  if (dw >= 0) { const cur = new Date(`${today}T00:00:00Z`).getUTCDay(); let n = (dw - cur + 7) % 7; if (n === 0) n = 7; return add(n); }
  return null;
}
function codeFields(text) {
  const raw = String(text || '').replace(/\r/g, '');
  const lines = raw.split('\n').map((l) => l.replace(/[|•·]+/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const f = {};
  const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.exec(raw); if (email) f.email = email[0].toLowerCase();
  const phones = (raw.match(/(?:\+?91[\s-]?)?(?:\(?0?\d{2,4}\)?[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b|\+?91[\s-]?[6-9]\d{9}\b|\b[6-9]\d{9}\b/g) || []).map((p) => p.replace(/\D/g, '').slice(-10)).filter((p) => /^[6-9]\d{9}$/.test(p));
  if (phones.length) f.phone = phones[0];
  const web = /\b(?:https?:\/\/)?(?:www\.)[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?/i.exec(raw) || /\bhttps?:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+\S*/i.exec(raw);
  if (web) f.website = web[0].replace(/[),.;]+$/, '');
  const gst = /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/.exec(raw.toUpperCase()); if (gst) f.gstin = gst[0];
  const pin = /\b[1-9]\d{2}\s?\d{3}\b/.exec(raw.replace(/[6-9]\d{9}/g, '')); if (pin && /pin|hyderabad|bengaluru|bangalore|chennai|mumbai|pune|delhi|road|nagar|colony|street|floor|india|-\s?\d{6}/i.test(raw)) f.pincode = pin[0].replace(/\s/g, '');
  const city = CITIES.find((c) => new RegExp(`\\b${c}\\b`, 'i').test(raw)); if (city) f.city = city === 'Bangalore' ? 'Bengaluru' : city === 'Gurgaon' ? 'Gurugram' : city === 'Vizag' ? 'Visakhapatnam' : city === 'Mysore' ? 'Mysuru' : city;
  const plain = (l) => !/@|www\.|https?:|\d{5,}/i.test(l);
  const coLine = lines.find((l) => CO_WORDS.test(l) && plain(l) && l.length <= 80);
  if (coLine) f.company = coLine.replace(/^(company|organisation|organization)\s*[:-]\s*/i, '');
  else if (f.email && !FREE_MAIL.test(f.email)) f.company = titleCase(f.email.split('@')[1].split('.')[0].replace(/[-_]/g, ' '));
  else if (f.website) f.company = titleCase(f.website.replace(/^(https?:\/\/)?(www\.)?/i, '').split('.')[0].replace(/[-_]/g, ' '));
  const desLine = lines.find((l) => DESIG.test(l) && l !== coLine && plain(l) && l.length <= 60 && l.split(' ').length <= 7);
  if (desLine) f.designation = desLine.replace(/^(designation|title|role)\s*[:-]\s*/i, '');
  // the name: after "Regards," / "Thanks," in a mail; on a card a short line of 2-4 words with only letters
  const sign = /(?:regards|thanks|thank you|sincerely|cheers|best)[,!.]?\s*\n+\s*([A-Za-z][A-Za-z.]+(?: [A-Za-z][A-Za-z.]+){0,3})\s*(?:\n|$)/i.exec(raw);
  const nameLine = sign ? sign[1] : lines.find((l) => /^[A-Za-z][A-Za-z.]*(?: [A-Za-z][A-Za-z.]*){1,3}$/.test(l) && l !== coLine && l !== desLine && !DESIG.test(l) && !CO_WORDS.test(l) && !CITIES.some((c) => c.toLowerCase() === l.toLowerCase()));
  if (nameLine) f.contactName = titleCase(nameLine.trim());
  const ind = INDUSTRY.find(([, re]) => re.test(`${f.company || ''} ${raw}`.toLowerCase())); if (ind) f.industry = ind[0];
  const value = moneyIn(raw); if (value) f.expectedValue = value;
  const when = /(follow ?up|call back|meet|meeting|decision|revert|next)/i.test(raw) ? dateIn(raw) : null; if (when) f.nextDate = when;
  return f;
}
const inText = (v, text) => !!v && String(text).toLowerCase().includes(String(v).toLowerCase().slice(0, 40));
async function extractFields(text, { useAi = true } = {}) {
  const t = clip(text, 8000) || '';
  const f = codeFields(t);
  let by = 'code'; let note = null;
  if (useAi && t.length >= 20) {
    try {
      const fa = require('../utils/fastAi'); // eslint-disable-line global-require
      const res = await fa.chat('You read a business mail, an email signature, a visiting card or call notes for a sales CRM in India. Reply ONLY as JSON: {"company":"","contactName":"","designation":"","city":"","industry":"","phone":"","email":"","website":""}. Copy words exactly as they are in the text; leave a field empty when it is not there. Never guess.', [{ role: 'user', content: t }], { json: true, maxTokens: 300, purpose: 'CRM field extraction', fallbackToApp: false, deadlineMs: 15000 });
      const j = require('../utils/ai').parseJsonLoose(res.text) || {}; // eslint-disable-line global-require
      // the AI may only fill a field with words that are in the text (an industry may be its own word)
      ['company', 'contactName', 'designation', 'city', 'website'].forEach((k) => { const v = clip(j[k], 120); if (v && inText(v, t) && (!f[k] || (k === 'contactName' && v.split(' ').length >= 2) || (k === 'company' && !CO_WORDS.test(f.company || '')))) f[k] = v; });
      if (!f.industry && clip(j.industry, 60)) f.industry = clip(j.industry, 60);
      by = res.provider || 'AI';
    } catch (e) { note = `Read by code only (the AI is not available: ${clip(e.message, 80)}).`; }
  }
  return { fields: f, by, note };
}
const LEAD_FIELDS = ['company', 'contactName', 'designation', 'phone', 'email', 'industry', 'city', 'expectedValue'];
const FILL = { lead: LEAD_FIELDS, account: ['name', 'industry', 'city', 'website', 'phone', 'email', 'gstin', 'pincode'], contact: ['name', 'designation', 'phone', 'email'], deal: ['value', 'expectedClose', 'nextStep'] };
async function extract(user, { text } = {}) {
  if (!S.roleOf(user)) return S.fail(403, 'No CRM access.');
  const t = clip(text, 8000);
  if (!t || t.length < 6) return S.fail(400, 'Paste the mail, the signature or the card text first.');
  const out = await extractFields(t);
  const lead = Object.fromEntries(LEAD_FIELDS.filter((k) => out.fields[k] != null).map((k) => [k, out.fields[k]]));
  if (out.fields.website || out.fields.gstin || out.fields.pincode) lead.notes = [out.fields.website && `Website: ${out.fields.website}`, out.fields.gstin && `GSTIN: ${out.fields.gstin}`, out.fields.pincode && `Pincode: ${out.fields.pincode}`].filter(Boolean).join('\n');
  return S.okBody({ lead, fields: out.fields, by: out.by, note: out.note });
}
// suggestions for the EMPTY fields of a record already there
async function fillSuggest(user, kind, id, { text } = {}) {
  const r = await P.editable(user, kind, id);
  if (r.error) return r.error;
  const t = clip(text, 8000);
  if (!t || t.length < 6) return S.fail(400, 'Paste the mail, the call notes or the card text first.');
  const out = await extractFields(t);
  const f = { ...out.fields, name: kind === 'contact' ? out.fields.contactName : out.fields.company, value: out.fields.expectedValue, expectedClose: out.fields.nextDate };
  if (kind === 'deal') { const step = /next step[:\s-]+([^\n.]{4,120})/i.exec(t) || /(send (?:the )?(?:proposal|quote|quotation|agreement)[^\n.]{0,80})/i.exec(t); if (step) f.nextStep = step[1].trim(); }
  const suggest = {};
  (FILL[kind] || []).forEach((k) => { const cur = r.row[k]; if ((cur == null || cur === '' || cur === 0) && f[k] != null && f[k] !== '') suggest[k] = f[k]; });
  return S.okBody({ suggest, by: out.by, note: out.note });
}
const kindOfImage = (b) => (b && b[0] === 0xff && b[1] === 0xd8 ? 'jpg' : b && b[0] === 0x89 && b[1] === 0x50 ? 'png' : null);
async function card(user, buffer) {
  if (!S.roleOf(user)) return S.fail(403, 'No CRM access.');
  if (!Buffer.isBuffer(buffer) || buffer.length < 100) return S.fail(400, 'Take or choose a photo of the card.');
  const k = kindOfImage(buffer);
  if (!k) return S.fail(400, 'Use a JPG or PNG photo (an iPhone HEIC photo: set the camera to "Most compatible", or take a screenshot of it).');
  const ocr = await require('../utils/resumeOcr').ocrBuffer(buffer, k); // eslint-disable-line global-require
  if (ocr.notInstalled) return S.fail(409, 'The card reader (OCR) is not installed on the server yet, so the photo could not be read. Type or paste the card text instead. (Server: docs/OCR-SETUP.md)', { notInstalled: true });
  if (ocr.busy) return S.fail(503, 'The card reader is busy; try again in a minute.');
  if (!ocr.text) return S.fail(422, ocr.error ? String(ocr.error).replace(/^Scanned resume — /, '') : 'No text was found on the photo. Take it again in good light, the card filling the picture.');
  const out = await extract(user, { text: ocr.text });
  if (out.status !== 200) return out;
  return S.okBody({ ...out.body, text: ocr.text, lead: { ...out.body.lead, notes: ['Added from a visiting card photo.', out.body.lead.notes].filter(Boolean).join('\n') } });
}

// ---- 3. unusual changes ----------------------------------------------------------------------------------------------------------
const mondayOf = (ymd) => { const d = new Date(`${ymd}T00:00:00Z`); const dow = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - dow); return d.toISOString().slice(0, 10); };
const plusDays = (ymd, n) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
// an IST day as the UTC moment it starts
const istStart = (ymd) => new Date(Date.parse(`${ymd}T00:00:00Z`) - 5.5 * 3600 * 1000).toISOString();
const METRICS = [
  ['leads', 'New leads', 3], ['work', 'Calls, meetings, mails and WhatsApps logged', 5], ['wonValue', 'Value of deals won', 0], ['won', 'Deals won', 2], ['lost', 'Deals lost', 2], ['done', 'Follow-ups done', 5],
];
async function weekly(user, r, weeks) {
  const own = !S.seesAll(r);
  const from = istStart(weeks[0]); const to = istStart(plusDays(weeks[weeks.length - 1], 7));
  const bucket = (iso) => { const ist = new Date(Date.parse(iso) + 5.5 * 3600 * 1000).toISOString().slice(0, 10); return mondayOf(ist); };
  const series = Object.fromEntries(METRICS.map(([k]) => [k, Object.fromEntries(weeks.map((w) => [w, 0]))]));
  const ownerWork = new Map();
  const leads = await DB.all(`SELECT "createdAt" FROM "CrmLead" WHERE "createdAt" >= ? AND "createdAt" < ?${own ? ' AND "ownerId" = ?' : ''}`, from, to, ...(own ? [user.id] : []));
  leads.forEach((x) => { const w = bucket(x.createdAt); if (w in series.leads) series.leads[w] += 1; });
  const acts = await DB.all(`SELECT "at", "byId", "byName" FROM "CrmActivity" WHERE "at" >= ? AND "at" < ? AND "byId" IS NOT NULL AND "kind" IN ('call', 'meeting', 'email', 'whatsapp') AND COALESCE("subject", '') NOT LIKE 'Stage:%'${own ? ' AND "byId" = ?' : ''}`, from, to, ...(own ? [user.id] : []));
  acts.forEach((x) => {
    const w = bucket(x.at); if (!(w in series.work)) return;
    series.work[w] += 1;
    if (!ownerWork.has(x.byId)) ownerWork.set(x.byId, { name: x.byName, weeks: Object.fromEntries(weeks.map((k) => [k, 0])) });
    ownerWork.get(x.byId).weeks[w] += 1;
  });
  const deals = await DB.all(`SELECT "wonAt", "lostAt", "value", "finalValue" FROM "CrmDeal" WHERE (("wonAt" >= ? AND "wonAt" < ?) OR ("lostAt" >= ? AND "lostAt" < ?))${own ? ' AND "ownerId" = ?' : ''}`, from, to, from, to, ...(own ? [user.id] : []));
  deals.forEach((d) => {
    if (d.wonAt) { const w = bucket(d.wonAt); if (w in series.won) { series.won[w] += 1; series.wonValue[w] += Number(d.finalValue || d.value) || 0; } }
    if (d.lostAt) { const w = bucket(d.lostAt); if (w in series.lost) series.lost[w] += 1; }
  });
  const done = await DB.all(`SELECT "doneAt" FROM "CrmTask" WHERE "status" = 'Done' AND "doneAt" >= ? AND "doneAt" < ?${own ? ' AND "ownerId" = ?' : ''}`, from, to, ...(own ? [user.id] : []));
  done.forEach((x) => { const w = bucket(x.doneAt); if (w in series.done) series.done[w] += 1; });
  return { series, ownerWork };
}
const stats = (arr) => { const n = arr.length; const m = arr.reduce((a, b) => a + b, 0) / (n || 1); const sd = Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, n - 1)); return { m, sd }; };
const fmt = (k, v) => (k === 'wonValue' ? `₹${Math.round(v).toLocaleString('en-IN')}` : String(Math.round(v * 10) / 10));
async function anomalies(user) {
  const r = S.roleOf(user);
  if (!r) return S.fail(403, 'No CRM access.');
  const thisWeek = mondayOf(S.istToday());
  const weeks = Array.from({ length: 10 }, (_, i) => plusDays(thisWeek, (i - 9) * 7)); // 9 complete weeks + this one
  const { series, ownerWork } = await weekly(user, r, weeks);
  const last = weeks[8]; const before = weeks.slice(0, 8);
  const alerts = [];
  for (const [k, label, minAbs] of METRICS) {
    const x = series[k][last]; const { m, sd } = stats(before.map((w) => series[k][w]));
    const diff = x - m;
    const absMin = k === 'wonValue' ? Math.max(1, m * 0.5) : minAbs;
    let hit = false;
    if (sd > 0 && Math.abs(diff) >= 2 * sd && Math.abs(diff) >= absMin) hit = true;
    if (m >= 3 && x === 0 && k !== 'lost') hit = true;
    if (sd === 0 && m === 0 && x >= Math.max(3, absMin) && k !== 'wonValue') hit = true;
    if (!hit) continue; // eslint-disable-line no-continue
    const up = diff > 0;
    const good = k === 'lost' ? !up : up;
    alerts.push({ metric: k, label, direction: up ? 'up' : 'down', good, value: x, usual: Math.round(m * 10) / 10, week: last, severity: Math.abs(diff) >= 3 * (sd || 1) ? 'high' : 'medium', text: `${label} ${up ? 'rose' : 'fell'} to ${fmt(k, x)} last week (usual ${fmt(k, m)} a week).` });
  }
  if (S.seesAll(r)) {
    for (const [, o] of ownerWork) {
      const x = o.weeks[last]; const { m } = stats(before.map((w) => o.weeks[w]));
      if (m >= 5 && x < m * 0.4) alerts.push({ metric: 'ownerWork', label: `${o.name || 'A salesperson'}: contacts logged`, direction: 'down', good: false, value: x, usual: Math.round(m * 10) / 10, week: last, severity: x === 0 ? 'high' : 'medium', text: `${o.name || 'A salesperson'} logged ${x} call(s) / meeting(s) / message(s) last week (usual ${Math.round(m)} a week).` });
    }
  }
  // this week so far, for the screen only (not judged: it is not over)
  return S.okBody({ alerts, weeks, series, week: last, thisWeek, scope: S.seesAll(r) ? 'team' : 'mine' });
}
// Monday 10:00: one bell to the Sales managers with last week's unusual changes (only while the Admin switch is on; once a week)
async function alertManagers() {
  const st = await P.settings();
  if (!st.anomalyAlerts) return 0;
  const prisma = require('../db'); // eslint-disable-line global-require
  const week = mondayOf(S.istToday());
  const key = 'crm.plus.anomalySent';
  const sent = await prisma.appSetting.findUnique({ where: { key } }).catch(() => null);
  if (sent && sent.value === week) return 0;
  const SETTINGS = require('./settings'); // eslint-disable-line global-require
  const cfg = await SETTINGS.load();
  const managers = cfg.salesTeam.filter((m) => m.role === 'manager').map((m) => m.userId);
  if (!managers.length) return 0;
  const out = await anomalies({ id: managers[0], role: 'ADMIN', name: 'TeamLink' });
  await prisma.appSetting.upsert({ where: { key }, create: { key, value: week }, update: { value: week } });
  const list = (out.body && out.body.alerts) || [];
  if (!list.length) return 0;
  await require('../utils/notify').notifyUsers(managers, { title: `CRM: ${list.length} unusual change(s) last week`, message: list.slice(0, 4).map((a) => a.text).join(' '), open: '/crm/dashboard' }).catch(() => null); // eslint-disable-line global-require
  return list.length;
}

// ---- 4. calls ------------------------------------------------------------------------------------------------------------------------
const BC = () => require('../browsercall/schema'); // eslint-disable-line global-require
const DIGITS = 'substr(replace(replace(replace(replace(COALESCE("toNumber", \'\'), \' \', \'\'), \'-\', \'\'), \'+\', \'\'), \'(\', \'\'), -10)';
async function browserCallsFor(user, r, phones) {
  if (!phones.length) return [];
  const own = S.seesAll(r) ? '' : ' AND "userId" = ?';
  try {
    await BC().ensure();
    return await BC().all(`SELECT "id", "userId", "userName", "toNumber", "status", "startAt", "talkSec", "durationSec", "recordingStatus", "summaryText", "summary", "summarySource", CASE WHEN "transcript" IS NULL THEN 0 ELSE 1 END AS "hasTranscript"
      FROM "BrowserCall" WHERE ${DIGITS} IN (${phones.map(() => '?').join(',')})${own} ORDER BY "startAt" DESC LIMIT 30`, ...phones, ...(own ? [user.id] : []));
  } catch { return []; }
}
async function recordedCalls(user, kind, id) {
  const rr = await P.readable(user, kind, id);
  if (rr.error) return rr.error;
  const r = S.roleOf(user);
  const phones = await P.phonesOf(kind, rr.row);
  const calls = await browserCallsFor(user, r, phones);
  const refs = calls.length ? await DB.all(`SELECT "providerRef" FROM "CrmActivity" WHERE "providerRef" IN (${calls.map(() => '?').join(',')})`, ...calls.map((c) => `bcall:${c.id}`)) : [];
  const linked = new Set(refs.map((x) => x.providerRef));
  return S.okBody({
    phones,
    calls: calls.map((c) => {
      let parts = null; try { parts = c.summary ? JSON.parse(c.summary) : null; } catch { parts = null; }
      return { id: c.id, by: c.userName, at: c.startAt, status: c.status, talkSec: c.talkSec, recording: c.recordingStatus, summary: c.summaryText || null, parts, hasTranscript: !!c.hasTranscript, onTimeline: linked.has(`bcall:${c.id}`) };
    }),
  });
}
async function writeCallLine(row, kind, c, byId, byName) {
  const now = DB.nowIso();
  const lk = kind === 'deal' ? { dealId: row.id, accountId: row.accountId || null } : kind === 'lead' ? { leadId: row.id, accountId: row.accountId || null } : { accountId: row.id };
  const mins = c.talkSec ? Math.max(1, Math.round(c.talkSec / 60)) : null;
  const act = { id: S.newId('act'), kind: 'call', subject: `Recorded call${mins ? ` (${mins} min)` : ''}${c.userName ? ` by ${c.userName}` : ''}`, note: clip(c.summaryText, 3000) || 'The call was recorded; the summary is not ready yet.', at: c.startAt || now, ...lk, byId, byName, createdAt: now, providerRef: `bcall:${c.id}` };
  await S.insert('CrmActivity', act);
  if (c.talkSec) await P.run('UPDATE "CrmActivity" SET "durationSec" = ? WHERE "id" = ?', Number(c.talkSec), act.id);
  return act;
}
async function linkCall(user, callId, { kind, id } = {}) {
  const rr = await P.editable(user, kind, id);
  if (rr.error) return rr.error;
  const r = S.roleOf(user);
  const phones = await P.phonesOf(kind, rr.row);
  const c = (await browserCallsFor(user, r, phones)).find((x) => x.id === String(callId || ''));
  if (!c) return S.fail(404, 'That call is not one of this record\'s numbers, or it is not yours.');
  const dup = await DB.one('SELECT "id" FROM "CrmActivity" WHERE "providerRef" = ?', `bcall:${c.id}`);
  if (dup) return S.okBody({ ok: true, already: true, activityId: dup.id });
  const act = await writeCallLine(rr.row, kind, c, user.id, user.name || null);
  return S.okBody({ ok: true, activityId: act.id });
}
// every 10 minutes, only while the Admin switch is on: a recorded call (with its summary) to a lead's number goes on that lead's timeline
async function autoLinkCalls() {
  const st = await P.settings();
  if (!st.autoLinkCalls) return 0;
  let n = 0;
  try {
    await BC().ensure();
    const since = new Date(Date.now() - 3 * 86400000).toISOString();
    const calls = await BC().all(`SELECT "id", "userName", "toNumber", "startAt", "talkSec", "summaryText", ${DIGITS} AS "d" FROM "BrowserCall" WHERE "startAt" >= ? AND "summaryText" IS NOT NULL LIMIT 300`, since);
    for (const c of calls) {
      // eslint-disable-next-line no-await-in-loop
      if (!c.d || c.d.length < 10 || await DB.one('SELECT "id" FROM "CrmActivity" WHERE "providerRef" = ?', `bcall:${c.id}`)) continue; // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      const lead = await DB.one('SELECT * FROM "CrmLead" WHERE substr(replace(replace(replace(COALESCE("phone", \'\'), \' \', \'\'), \'-\', \'\'), \'+\', \'\'), -10) = ? AND "status" <> \'Junk\' ORDER BY "updatedAt" DESC LIMIT 1', c.d);
      // eslint-disable-next-line no-await-in-loop
      if (lead) { await writeCallLine(lead, 'lead', c, null, 'TeamLink'); n += 1; }
    }
  } catch (e) { console.error('[crm plus] call link:', e.message); } // eslint-disable-line no-console
  return n;
}
// a salesperson's own call notes / a pasted transcript -> a short summary + the next step (+ save it as the call)
function codeSummary(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const sentences = t.split(/(?<=[.!?])\s+/).filter((s) => s.length > 3);
  const s = sentimentOf(t) || { label: 'Neutral', intent: null };
  const next = sentences.find((x) => /(will|shall|to send|send|call back|follow ?up|meet|next|revert|tomorrow|monday|tuesday|wednesday|thursday|friday|week)/i.test(x));
  return { summary: sentences.slice(0, 3).join(' ').slice(0, 600) || t.slice(0, 600), nextStep: next ? next.slice(0, 200) : '', nextDate: dateIn(t) || '', sentiment: s.label, intent: s.intent || '', interest: s.intent === 'Not interested' ? 'None' : s.label === 'Positive' ? 'High' : s.label === 'Negative' ? 'Low' : 'Medium' };
}
async function callSummary(user, kind, id, { text, save, durationSec, outcome } = {}) {
  const rr = await (save ? P.editable(user, kind, id) : P.readable(user, kind, id));
  if (rr.error) return rr.error;
  const t = clip(text, 12000);
  if (!t || t.length < 15) return S.fail(400, 'Type or paste what was said on the call first (a few lines).');
  let out = codeSummary(t); let by = 'code'; let note = null;
  try {
    const fa = require('../utils/fastAi'); // eslint-disable-line global-require
    const res = await fa.chat(`You summarise a salesperson's phone call with a customer for TeamLink CRM (a recruitment company in India). The text may mix English, Telugu and Hindi. Use ONLY what is in the text; never add a number, name or date. Today is ${S.istToday()}.
Reply ONLY as JSON: {"summary":"<2-4 short sentences>","nextStep":"<what we do next, or empty>","nextDate":"YYYY-MM-DD or empty","sentiment":"Positive|Neutral|Negative","intent":"Wants a meeting|Asks for details|Price concern|Complaint|Not interested|Later|Ready to go ahead|","interest":"High|Medium|Low|None","objections":["..."]}`, [{ role: 'user', content: t }], { json: true, maxTokens: 450, purpose: 'CRM call summary', fallbackToApp: false, deadlineMs: 20000 });
    const j = require('../utils/ai').parseJsonLoose(res.text); // eslint-disable-line global-require
    if (j && clip(j.summary, 1500)) {
      out = { summary: clip(j.summary, 1500), nextStep: clip(j.nextStep, 300) || '', nextDate: /^\d{4}-\d{2}-\d{2}$/.test(String(j.nextDate)) && j.nextDate >= S.istToday() ? j.nextDate : out.nextDate, sentiment: ['Positive', 'Neutral', 'Negative'].includes(j.sentiment) ? j.sentiment : out.sentiment, intent: clip(j.intent, 40) || out.intent, interest: ['High', 'Medium', 'Low', 'None'].includes(j.interest) ? j.interest : out.interest, objections: (Array.isArray(j.objections) ? j.objections : []).map((x) => clip(x, 160)).filter(Boolean).slice(0, 4) };
      by = res.provider || 'AI';
    }
  } catch (e) { note = `Summarised by code (the AI is not available: ${clip(e.message, 80)}).`; }
  const body = { ...out, by, note };
  if (save) {
    const mins = Number(durationSec) > 0 ? Math.max(1, Math.round(Number(durationSec) / 60)) : null;
    const lines = [out.summary, out.nextStep ? `Next: ${out.nextStep}` : '', out.objections && out.objections.length ? `Concerns: ${out.objections.join('; ')}` : '', `Tone: ${out.sentiment}${out.intent ? ` · ${out.intent}` : ''}`].filter(Boolean);
    const a = await S.addActivity(user, { kind: 'call', [`${kind}Id`]: id, subject: `Call summary${mins ? ` (${mins} min)` : ''}`, note: lines.join('\n'), outcome: outcome || undefined, followUp: out.nextDate ? { dueDate: out.nextDate, title: out.nextStep ? clip(`Follow up: ${out.nextStep}`, 200) : undefined } : undefined });
    if (a.status !== 200) return a;
    if (mins && a.body.activity) await P.run('UPDATE "CrmActivity" SET "durationSec" = ? WHERE "id" = ?', Math.round(Number(durationSec)), a.body.activity.id);
    body.saved = { activityId: a.body.activity && a.body.activity.id, taskId: a.body.task && a.body.task.id, openFollowUps: a.body.openFollowUps || [] };
  }
  return S.okBody(body);
}

module.exports = { sentimentOf, sentiment, codeFields, extractFields, extract, fillSuggest, card, anomalies, alertManagers, recordedCalls, linkCall, autoLinkCalls, callSummary, codeSummary, dateIn, moneyIn };
