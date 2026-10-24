// Shared little helpers of the four vendor modules (2026-10-19). Same money / date style the vendor portal always used.
export const inr = (n) => (n == null || n === '' ? '-' : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);
const two = (n) => String(n).padStart(2, '0');
export const day = (s) => {
  if (!s) return '-';
  const d = new Date(String(s).length === 10 ? `${s}T00:00:00` : s);
  return Number.isNaN(d.getTime()) ? String(s) : `${two(d.getDate())}-${two(d.getMonth() + 1)}-${d.getFullYear()}`;
};
export const TONE = { PAID: 'green', PENDING_PAYMENT: 'blue', PENDING_REVIEW: 'yellow', VERIFIED: 'yellow', REJECTED: 'red', WITHDRAWN: 'grey' };
// A fresh key for one deliberate click.
export const newKey = () => (window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : `k${Date.now()}${Math.random().toString(16).slice(2)}`);
