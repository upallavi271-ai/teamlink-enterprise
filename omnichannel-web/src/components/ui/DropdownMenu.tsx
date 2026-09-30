import { useRef, useState, useEffect, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';

export interface MenuItem { label: string; onClick: () => void; danger?: boolean; disabled?: boolean }
export function DropdownMenu({ items, trigger }: { items: MenuItem[]; trigger?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  return (
    <div ref={ref} className="relative inline-block">
      <button onClick={() => setOpen((o) => !o)} className="rounded-lg p-1.5 text-muted hover:bg-surface-2" aria-label="Actions">
        {trigger ?? <MoreHorizontal size={18} />}
      </button>
      {open && (
        <div className="absolute right-0 z-10 mt-1 w-44 rounded-card border border-line bg-surface p-1 shadow-card">
          {items.map((it, i) => (
            <button key={i} disabled={it.disabled}
              onClick={() => { setOpen(false); it.onClick(); }}
              className={`block w-full rounded-lg px-2.5 py-2 text-left text-sm disabled:opacity-40 hover:bg-surface-2 ${it.danger ? 'text-red' : 'text-ink'}`}>
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
