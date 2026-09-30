import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

// A thin, reusable table shell. Every list module composes this rather than
// rebuilding table markup. Horizontal scroll is built in for narrow screens.
export interface Column<T> { key: string; header: ReactNode; render: (row: T) => ReactNode; className?: string }

export function DataTable<T>({ columns, rows, rowKey, empty }: {
  columns: Column<T>[]; rows: T[]; rowKey: (row: T) => string; empty?: ReactNode;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
            {columns.map((c) => (
              <th key={c.key} className={cn('px-4 py-3 font-medium', c.className)}>{c.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={columns.length} className="px-4 py-10 text-center text-muted">{empty ?? 'No records.'}</td></tr>
          ) : (
            rows.map((row) => (
              <tr key={rowKey(row)} className="border-b border-line last:border-0 hover:bg-surface-2">
                {columns.map((c) => <td key={c.key} className={cn('px-4 py-3 text-ink', c.className)}>{c.render(row)}</td>)}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
