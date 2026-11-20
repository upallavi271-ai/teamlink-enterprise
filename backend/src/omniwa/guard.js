// ---------------------------------------------------------------------------
// WHATSAPP AI AGENT: the rules that must hold whatever the language model says. Pure functions, no database. The model only ever writes a DRAFT:
// these decide, in code, when a person asked to stop, asked for a human or was abusive, and whether a draft may be sent at all.
// ---------------------------------------------------------------------------
const STOP_WORDS = /^\s*(stop|stop all|unsubscribe|un\s*subscribe|opt\s*out|optout|remove me|cancel|block|no more messages?|don'?t message( me)?|do not message( me)?|do not contact( me)?)\s*[.!]*\s*$/i;
const STOP_LOCAL = /(ఆపండి|ఆపేయండి|మెసేజ్ చేయకండి|పంపకండి|बंद करो|मैसेज मत|संदेश मत|मत भेजो|message cheyakandi|msg cheyakandi|messages pampakandi|message pampakandi|aapandi|apandi messages|mat bhejo|message mat karo|band karo message|messages band)/i;
function isStop(text) { const t = String(text || ''); return STOP_WORDS.test(t) || STOP_LOCAL.test(t); }

const HUMAN = /(\b(human|real person|recruiter|someone|somebody|manager|agent|executive|representative|team\s*lead)\b.*\b(talk|speak|call|connect|contact)\b|\b(talk|speak|call|connect)\b.*\b(human|real person|recruiter|someone|somebody|manager|agent|executive|representative|team\s*lead)\b|\bcall me\b|\bcall back\b|మనిషి|రిక్రూటర్|ఎవరైనా|మాట్లాడాలి|కాల్ చేయండి|किसी से बात|बात करनी|इंसान|कॉल करो|कॉल कीजिए|evaraina|evarainaa|manishi tho|recruiter tho|matladali|call cheyandi|call cheyyandi|kisi se baat|baat karni|baat karna|insaan se)/i;
function wantsHuman(text) { return HUMAN.test(String(text || '')); }
// "call me", "can we talk on call", "connect on call", "call cheyandi": they want a phone call (founder 2026-11-09: "ok I will connect you soon")
const CALL = /(\bcall\s*(me|back|now|later|please|pls|plz)\b|\b(please|pls|plz|can you|could you|kindly)\s+call\b|\b(talk|speak|connect|discuss|connected)\b.*\b(on|over|by|via|through)\s+(a\s+)?(call|phone)\b|\b(on|over)\s+(a\s+)?call\b|\bcall\s*(lo|lone|chesi|cheyandi|cheyyandi|cheyyi|chey|cheyu|cheyara|karo|kariye|kijiye)\b|\bphone\s*(cheyandi|chey|cheyyandi|karo|me)\b|\b(can|could|shall|may)\s+(we|you|i)\s+(talk|speak|connect)\b)/i;
function wantsCall(text) { return CALL.test(String(text || '')); }

const ABUSE = /\b(fuck\w*|bastard|asshole|idiot|stupid|bitch|scam(mer)?|fraud|chutiya|madarchod|bhenchod|bhosdi\w*|lanja|lanjakoduku|dengey|dengu|pichi\s*pooka)\b/i;
function isAbusive(text) { return ABUSE.test(String(text || '')); }

// a sentence that talks about pay or perks must rest on the facts this run was given (the job, the knowledge base)
const PAY = /(₹|\brs\.?\s*\d|\binr\b|\blpa\b|\blakhs?\b|\blacs?\b|\bctc\b|\bsalary\b|\bsalaries\b|\bper month\b|\bstipend\b|\bpackage\b|జీతం|वेतन|सैलरी|తనఖా)/i;
const PERKS = ['bonus', 'incentive', 'insurance', 'accommodation', 'hostel', 'free food', 'meals', 'cab', 'transport', 'relocation', 'pf', 'esi', 'gratuity', 'paid leave'];
const numbersIn = (t) => (String(t || '').replace(/,/g, '').match(/\d+(?:\.\d+)?/g) || []);
function promiseProblem(reply, factsText) {
  const facts = String(factsText || '').toLowerCase();
  const known = new Set(numbersIn(facts));
  for (const sentence of String(reply || '').split(/(?<=[.!?\n।])\s*/)) {
    if (PAY.test(sentence)) {
      const nums = numbersIn(sentence);
      if (nums.some((n) => !known.has(n))) return `A pay figure that is not in the job data: "${sentence.trim().slice(0, 120)}"`;
      if (!nums.length && !/\bsalary\b|\bctc\b|\bpackage\b|జీతం|वेतन|सैलरी/i.test(facts)) return `Talks about pay with no pay in the job data: "${sentence.trim().slice(0, 120)}"`;
    }
    const low = sentence.toLowerCase();
    const perk = PERKS.find((p) => new RegExp(`\\b${p}\\b`).test(low) && !new RegExp(`\\b${p}\\b`).test(facts));
    if (perk) return `A benefit that is not in the job data: "${perk}"`;
  }
  return null;
}

// the model knows nothing about openings except the one job of this chat: a sentence that says what is open, filled or not found, and does not name that job, was invented
const JOB_WORD = /\b(jobs?|positions?|openings?|vacanc(?:y|ies)|roles?)\b/i;
const JOB_STATE = /\b(available|filled|open|closed|no longer|couldn'?t find|could not find|not find|don'?t have|do not have|we have)\b/i;
function jobClaim(reply, title = null) {
  const own = String(title || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3);
  const hit = String(reply || '').split(/(?<=[.!?\n।])\s*/).find((s) => JOB_WORD.test(s) && JOB_STATE.test(s) && !own.some((w) => s.toLowerCase().includes(w)) && !(title && /\bthis (job|position|role|post)\b/i.test(s)));
  return hit ? `Says something about openings that it does not know: "${hit.trim().slice(0, 120)}"` : null;
}

// only links TeamLink itself made may leave: a link typed by the model is taken out
function stripLinks(reply, allowed = []) {
  const ok = new Set(allowed);
  return String(reply || '').replace(/(?:https?:\/\/|www\.)[^\s)]+/gi, (u) => (ok.has(u) ? u : '')).replace(/[ \t]{2,}/g, ' ').trim();
}

const MAX_REPLY = 700;
function clipReply(text) {
  const t = String(text || '').trim();
  if (t.length <= MAX_REPLY) return t;
  const cut = t.slice(0, MAX_REPLY);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'), cut.lastIndexOf('? '));
  return (end > 200 ? cut.slice(0, end + 1) : cut).trim();
}

// IST working hours. from / to = 'HH:MM'; a range over midnight works. off = always inside.
const IST_MS = 5.5 * 3600 * 1000;
function insideHours(cfg, now = Date.now()) {
  if (!cfg || !cfg.hoursOn) return true;
  const mins = (s) => { const m = /^(\d{2}):(\d{2})$/.exec(String(s || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
  const a = mins(cfg.hoursFrom); const b = mins(cfg.hoursTo);
  if (a == null || b == null || a === b) return true;
  const d = new Date(now + IST_MS);
  const n = d.getUTCHours() * 60 + d.getUTCMinutes();
  return a < b ? n >= a && n < b : n >= a || n < b;
}

// MARKETING NUMBERS (founder 2026-11-20): our own prices and promises must rest on the promotion and the website. A rupee amount, a percentage off or a guarantee that neither says was invented.
// (The job-pay words of promiseProblem - "package", "per month" - are ordinary marketing words, so they are not what this checks.)
const MONEY = /(?:₹|\brs\.?|\binr\b)\s*\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s*(?:₹|rupees?|\brs\b|\binr\b|\blakhs?\b|\bk\b)|\b\d{1,3}\s*%\s*(?:off|discount)|\b(?:guarantee[sd]?|guaranteed)\b/gi;
function marketingProblem(reply, factsText) {
  const facts = String(factsText || '').toLowerCase().replace(/,/g, '');
  for (const sentence of String(reply || '').split(/(?<=[.!?\n।])\s*/)) {
    for (const m of sentence.match(MONEY) || []) {
      const key = m.toLowerCase().replace(/,/g, '').replace(/\s+/g, ' ').trim();
      if (!facts.includes(key) && !/guarantee/.test(key)) return `A price or discount that is not in the promotion or the website: "${sentence.trim().slice(0, 120)}"`;
      if (/guarantee/.test(key) && !/guarantee/.test(facts)) return `A guarantee that is not in the promotion or the website: "${sentence.trim().slice(0, 120)}"`;
    }
  }
  return null;
}

module.exports = { jobClaim, isStop, wantsHuman, wantsCall, isAbusive, promiseProblem, marketingProblem, stripLinks, clipReply, insideHours };
