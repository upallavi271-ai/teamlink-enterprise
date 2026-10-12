// Pull "<field> to <value>" facts out of plain text, for the create / update tools.
const { CLEAN } = require('./_shared');

const DEFAULT_STOPS = ['phone', 'mobile', 'email', 'mail', 'location', 'city', 'industry', 'contact', 'skills', 'department', 'dept', 'designation', 'team', 'experience', 'company', 'notice', 'salary', 'status', 'reason', 'openings', 'priority', 'with', 'having'];

function stopRe(stops) {
  return `(?:\\s+(?:${stops.join('|')})\\b|[,;]|$)`;
}

// grab("update location to Pune and phone ...", ['location','city']) -> "Pune"
function grab(text, words, { stops = DEFAULT_STOPS, max = 80 } = {}) {
  const w = words.map((x) => x.replace(/\s+/g, '\\s+')).join('|');
  const tail = stopRe(stops.filter((s) => !words.includes(s)));
  const tries = [
    new RegExp(`\\b(?:${w})\\b[^,;]{0,70}?\\s(?:to|as|=|:)\\s*(.+?)${tail}`, 'i'),
    new RegExp(`\\b(?:${w})\\b\\s*(?:is|=|:|-)?\\s+(.+?)${tail}`, 'i'),
  ];
  for (const re of tries) {
    const m = String(text || '').match(re);
    if (m && CLEAN(m[1])) {
      const v = CLEAN(m[1]).replace(/^(?:the|a|an)\s+/i, '').replace(/[.]+$/, '');
      if (v && v.length <= max) return v;
    }
  }
  return '';
}

// Try each span in turn with a finder; the first span that hits wins.
// finder(spanText) -> { rows, full } like lib/entities
async function locate(spans, finder) {
  for (const span of spans) {
    // eslint-disable-next-line no-await-in-loop
    const res = await finder(span);
    if (res && res.rows && res.rows.length) return { span, res };
  }
  return null;
}

// "client Sunrise Pharma in Hyderabad" -> "Sunrise Pharma": the words right after a
// keyword (client / candidate / employee ...), up to a field word, a place or a number.
function afterKeyword(text, keywords, { stops = [], lead = '' } = {}) {
  const k = keywords.map((x) => x.replace(/\s+/g, '\\s+')).join('|');
  const stop = [...DEFAULT_STOPS, 'in', 'at', 'from', 'for', 'dept', 'department', 'email', 'phone', 'mobile', ...stops].join('|');
  const leadRe = lead ? `|(?:${lead})\\s+` : '';
  const re = new RegExp(`\\b(?:${k})\\s+(?:named\\s+|called\\s+${leadRe})?(.+?)(?=\\s+(?:${stop})\\b|\\s+[\\w.+-]+@|\\s+\\+?\\d{5,}|[,;:]|$)`, 'i');
  const m = String(text || '').match(re);
  if (!m) return '';
  const v = CLEAN(m[1]).replace(/^(?:a|an|the|new)\s+/i, '').replace(/[.]+$/, '');
  return v.length >= 2 && v.length <= 80 ? v : '';
}

module.exports = { grab, locate, afterKeyword, DEFAULT_STOPS };
