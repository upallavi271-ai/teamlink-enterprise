/** Framework-free formatting helpers reused across modules. */
export function formatNumber(n: number): string {
  return new Intl.NumberFormat('en-IN').format(n);
}
export function formatCompact(n: number): string {
  return new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}
export function formatPercent(n: number, digits = 0): string {
  return `${n > 0 ? '+' : ''}${n.toFixed(digits)}%`;
}
export function initialsOf(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('') || '?';
}
