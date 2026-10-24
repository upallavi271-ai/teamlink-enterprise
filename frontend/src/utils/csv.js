// Shared CSV export used by the HRMS reporting screens (attendance, leave,
// payroll, the HRMS dashboard). Every cell is quoted and inner quotes doubled so
// commas, newlines and rupee amounts survive the round trip into Excel.
import api from '../api';

function encodeCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

export function toCsv(headers, rows) {
  return [headers, ...rows].map((row) => row.map(encodeCell).join(',')).join('\n');
}

export function downloadCsv(filename, headers, rows) {
  // A CSV built in the browser never touches the server, so an Internal HR login (utils/hrSuper.js) reports it here:
  // the Super Admins are told. Anyone else: the server answers 204 and does nothing.
  api.post('/admin/hr-sensitive/client-export', { name: filename, rows: Array.isArray(rows) ? rows.length : null, page: typeof window !== 'undefined' ? window.location.pathname : '' }).catch(() => {});
  // The byte-order mark makes Excel read names in any language (and the rupee sign) correctly.
  const blob = new Blob(['﻿', toCsv(headers, rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// "18:41" -> "6:41 PM". Anything that isn't a 24-hour clock time passes through.
export function to12h(time) {
  const m = String(time || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return time || '—';
  const h = Number(m[1]);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m[2]} ${suffix}`;
}

export const inr = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
