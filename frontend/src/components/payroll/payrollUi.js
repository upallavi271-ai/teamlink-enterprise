// Small shared pieces for the payroll run board, the payroll reports and the
// Accounts Journal & Ledger screen.
import api from '../../api';

export const STATUS_LABEL = {
  DRAFT: 'Draft', PENDING_APPROVAL: 'Pending Approval', APPROVED: 'Approved', SYNCED_TO_ACCOUNTS: 'Synced', PAID: 'Paid',
};
// Maps onto the app's existing .status pill colours (styles.css).
export const STATUS_CLS = {
  DRAFT: 'new', PENDING_APPROVAL: 'pending', APPROVED: 'interview', SYNCED_TO_ACCOUNTS: 'offer', PAID: 'paid',
};
export const SYNC_CLS = { PENDING: 'pending', SUCCESS: 'matched', FAILED: 'failed' };

export const money = (n) => `₹${(Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export function monthLabel(m) {
  if (!m) return '—';
  const [y, mm] = String(m).split('-');
  return `${MONTHS[Number(mm) - 1] || m} ${y}`;
}

export const errText = (err, fallback) => err?.response?.data?.error || err?.message || fallback;

// Summarises a bulk action's { ok, failed, results } answer.
export function bulkMessage(verb, data) {
  if (!data || !Array.isArray(data.results)) return data?.error || `${verb}: done`;
  const failed = data.results.filter((r) => !r.ok);
  const syncErr = data.results.filter((r) => r.syncError);
  let msg = `${verb}: ${data.ok} record(s)`;
  if (failed.length) msg += ` · ${failed.length} not moved — ${failed.slice(0, 3).map((f) => `${f.name || f.id}: ${f.error}`).join('; ')}${failed.length > 3 ? '…' : ''}`;
  if (syncErr.length) msg += ` · ${syncErr.length} approved but not yet synced (${syncErr[0].syncError}) — it will be retried`;
  return msg;
}

// Downloads an authenticated export (CSV / XLSX) from the API.
export async function downloadFile(url, filename) {
  const res = await api.get(url, { responseType: 'blob' });
  const href = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 2000);
}
