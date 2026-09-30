import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { cn } from '@/lib/cn';
import { toast } from '@/components/toast/toastStore';

/**
 * Refetches the page's data. Pass the query key PREFIXES the page owns — every
 * cached query starting with one of them is invalidated, so a page with several
 * queries refreshes as a unit.
 *
 * It waits for the refetch to settle before it stops spinning: a button that
 * finishes instantly while the table is still stale teaches people not to trust it.
 */
export function RefreshButton({ keys, label = 'Refresh', iconOnly = false, className, onDone }: {
  keys: string[];
  label?: string;
  iconOnly?: boolean;
  className?: string;
  onDone?: () => void;
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await Promise.all(keys.map((k) => qc.invalidateQueries({ queryKey: [k] })));
      onDone?.();
      toast.success('Refreshed');
    } catch {
      toast.error('Could not refresh. Check your connection.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={run}
      disabled={busy}
      title={label}
      aria-label={label}
      aria-busy={busy}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-[10px] border border-line bg-surface text-sm text-ink',
        'hover:bg-surface-2 disabled:opacity-60',
        iconOnly ? 'h-9 w-9' : 'h-9 px-3',
        className,
      )}
    >
      <RefreshCw size={15} className={cn('shrink-0 text-muted', busy && 'animate-spin')} />
      {!iconOnly && <span>{busy ? 'Refreshing…' : label}</span>}
    </button>
  );
}
