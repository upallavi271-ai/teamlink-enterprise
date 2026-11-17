// ---------------------------------------------------------------------------
// QUESTIONS A LEAD ASKS IN THE AI MEETING, with what a right answer must say and what it must never say (founder 2026-11-17: "it does not
// answer what is asked, it says whatever it likes"). Used by scripts/crm-meeting-answers-test.js (sandbox, written answers only) and by the
// live check on the server's own model. `written: true` = the written Q&A must answer it at once (no AI needed).
// ---------------------------------------------------------------------------
const NEVER = [
  [/\b(naukri|shine|indeed|linkedin|monster)\b[^.]*\b(one[- ]click|automatic(ally)?|by itself)\b|\b(one[- ]click|automatic(ally)?)\b[^.]*\b(naukri|shine|indeed|linkedin|monster)\b/i, 'claims automatic / one-click posting to a job board'],
  [/vannet/i, 'speech-to-text garbage ("Vannet search")'],
  [/discount/i, 'talks about a discount'],
  [/(includ\w*|inclusive)[^.]*gst|gst[^.]*(includ\w*|inclusive)|gst ?తో|gst సహా|జీఎస్టీతో/i, 'says the prices include GST (GST is extra)'],
  [/(,[^,]*){7,}/, 'a menu list instead of an answer'],
  [/\b(sap|successfactors|workday|darwinbox|keka|zoho)\b[^.]*\b(integrat\w*|connect\w*)\b(?![^.]*\b(confirm|check)\b)/i, 'claims an integration that is not in the product text'],
];
const QUESTIONS = [
  // the founder's three (L-0013, 2026-11-17)
  { id: 'F1', product: 'ATS', lang: 'en-IN', q: 'how the clients will come into the ads', must: [/\bBDE\b/, /(client[- ]portal|portal login|login)/i], written: true },
  { id: 'F2', product: 'ATS', lang: 'en-IN', q: 'how the clients will come into the ats', must: [/\bBDE\b/, /(client[- ]portal|portal login|login)/i], written: true },
  { id: 'F3', product: 'ATS', lang: 'en-IN', q: 'what does clients do in ats', must: [/requirement/i, /(shortlist|feedback|profiles|candidates)/i], written: true },
  // more client / HR questions
  { id: 'Q4', product: 'ATS', lang: 'en-IN', q: 'how do clients send requirements?', must: [/portal/i, /\bBDE\b/], written: true },
  { id: 'Q5', product: 'ATS', lang: 'en-IN', q: 'can the client see candidates?', must: [/(portal|shortlist)/i], written: true },
  { id: 'Q6', product: 'ATS', lang: 'en-IN', q: 'how does job posting work?', must: [/job portal/i, /google jobs/i], written: true },
  { id: 'Q7', product: 'ATS', lang: 'en-IN', q: 'can you post our jobs on LinkedIn automatically?', must: [/(job portal|careers|button|by hand|confirm|team)/i] },
  { id: 'Q8', product: 'ATS', lang: 'en-IN', q: 'what does it cost?', must: [/(₹|plan|price|quote)/i], written: true },
  { id: 'Q9', product: 'ATS', lang: 'en-IN', q: 'can I import my Excel data?', must: [/excel/i], written: true },
  { id: 'Q10', product: 'ATS', lang: 'en-IN', q: 'does it work on mobile?', must: [/(phone|mobile|browser)/i], written: true },
  { id: 'Q11', product: 'HRMS', lang: 'en-IN', q: 'does payroll calculate PF and ESI?', must: [/\bPF\b/], written: true },
  { id: 'Q12', product: 'ATS', lang: 'en-IN', q: 'do you integrate with SAP SuccessFactors?', must: [/(confirm|team)/i] },
  // price questions: the written answer, never a model (founder 2026-11-17: the local model said the prices include GST)
  { id: 'P1', product: 'ATS', lang: 'te-IN', q: 'price entha?', must: [/₹1,499/, /GST 18%/, /అదనంగా/, /నిర్ధారిస్తారు/], written: true },
  { id: 'P2', product: 'ATS', lang: 'en-IN', q: 'what is the cost', must: [/₹1,499/, /₹2,499/, /GST 18% is added on top/i, /confirms quotes for custom plans/i], written: true },
  { id: 'P3', product: 'ATS', lang: 'en-IN', q: 'GST included aa?', must: [/GST 18% is added on top/i], written: true },
  { id: 'T1', product: 'ATS', lang: 'te-IN', q: 'clients ATS loki ela vastaru?', must: [] },
  { id: 'T2', product: 'ATS', lang: 'te-IN', q: 'క్లయింట్ ATS లో ఏమి చేస్తారు?', must: [] },
  { id: 'T3', product: 'HRMS', lang: 'te-IN', q: 'ఇది మొబైల్ లో పని చేస్తుందా?', must: [] },
];
// what is wrong with an answer: [] when it is fine
function problemsOf(item, reply) {
  const r = String(reply || '');
  const out = [];
  item.must.forEach((re) => { if (!re.test(r)) out.push(`missing ${re}`); });
  NEVER.forEach(([re, why]) => { if (re.test(r)) out.push(why); });
  if (item.lang === 'te-IN' && !/[ఀ-౿]/.test(r) && !/our team will confirm|noted/i.test(r)) out.push('not in Telugu');
  return out;
}
module.exports = { QUESTIONS, NEVER, problemsOf };
