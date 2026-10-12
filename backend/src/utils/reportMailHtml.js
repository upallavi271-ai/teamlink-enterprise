// ---------------------------------------------------------------------------
// A SMALL HTML MAIL KIT for the report e-mails (the pending-work digest, the
// end-of-day report). Plain tables and inline styles only — the style every mail
// app understands — in the TeamLink blue/white look, readable on a phone
// (single column, 600 px wide, big numbers). Everything that comes from data is
// escaped here, so a candidate's name can never inject markup.
// ---------------------------------------------------------------------------
const esc = (v) => String(v === undefined || v === null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const BLUE = '#1d4ed8';
const TONES = {
  red: ['#fee2e2', '#b91c1c'],
  orange: ['#ffedd5', '#c2410c'],
  green: ['#dcfce7', '#15803d'],
  blue: ['#dbeafe', '#1d4ed8'],
  grey: ['#f1f5f9', '#475569'],
};

function pill(text, tone = 'grey') {
  const [bg, fg] = TONES[tone] || TONES.grey;
  return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;background:${bg};color:${fg};font-size:12px;font-weight:600">${esc(text)}</span>`;
}

// headers: ['Name', 'Late'], rows: [[cell, cell]]; a cell is text or { html }, a column may be right-aligned.
function table(headers, rows, { right = [] } = {}) {
  const cell = (c) => (c && typeof c === 'object' && c.html !== undefined ? c.html : esc(c));
  const th = headers.map((h, i) => `<th align="${right.includes(i) ? 'right' : 'left'}" style="padding:6px 8px;background:#eff6ff;color:#1e3a8a;font-size:12px;border-bottom:1px solid #bfdbfe">${esc(h)}</th>`).join('');
  const body = rows.map((r) => `<tr>${r.map((c, i) => `<td align="${right.includes(i) ? 'right' : 'left'}" style="padding:6px 8px;border-bottom:1px solid #e5e7eb;font-size:13px;color:#111827;vertical-align:top">${cell(c)}</td>`).join('')}</tr>`).join('');
  return `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:6px 0 14px"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`;
}

// Big numbers in a row: [{ label, value, tone }].
function stats(list) {
  return `<table width="100%" cellpadding="0" cellspacing="6" style="border-collapse:separate;margin:6px 0 14px"><tr>${list.map((s) => {
    const [bg, fg] = TONES[s.tone] || TONES.grey;
    return `<td align="center" style="background:${bg};border-radius:8px;padding:10px 4px"><div style="font-size:22px;font-weight:700;color:${fg}">${esc(s.value)}</div><div style="font-size:11px;color:#374151">${esc(s.label)}</div></td>`;
  }).join('')}</tr></table>`;
}

const h2 = (t) => `<h2 style="font-size:15px;color:${BLUE};margin:18px 0 4px">${esc(t)}</h2>`;
const p = (t) => `<p style="margin:6px 0;font-size:13px;color:#374151;line-height:1.5">${esc(t)}</p>`;
const button = (href, label) => `<p style="margin:12px 0"><a href="${esc(href)}" style="background:${BLUE};color:#ffffff;text-decoration:none;padding:9px 16px;border-radius:6px;font-size:13px;font-weight:600;display:inline-block">${esc(label)}</a></p>`;

function page(title, inner, { footer } = {}) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Segoe UI,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:12px 8px">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;border-radius:8px;border:1px solid #e5e7eb"><tr><td style="padding:0">
<div style="background:${BLUE};color:#ffffff;padding:14px 18px;border-radius:8px 8px 0 0;font-size:16px;font-weight:700">${esc(title)}</div>
<div style="padding:12px 18px 18px">${inner}</div>
<div style="padding:10px 18px;border-top:1px solid #e5e7eb;font-size:11px;color:#6b7280">${esc(footer || 'Sent by TeamLink. Numbers are the same as on your screens.')}</div>
</td></tr></table></td></tr></table></body></html>`;
}

module.exports = { esc, pill, table, stats, h2, p, button, page, TONES };
