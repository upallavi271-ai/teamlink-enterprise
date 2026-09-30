import { cn } from '@/lib/cn';
export interface Tab { key: string; label: string }
export function Tabs({ tabs, active, onChange }: { tabs: Tab[]; active: string; onChange: (k: string) => void }) {
  return (
    <div className="flex gap-1 overflow-x-auto border-b border-line" role="tablist">
      {tabs.map((t) => (
        <button key={t.key} role="tab" aria-selected={active === t.key} onClick={() => onChange(t.key)}
          className={cn('whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors',
            active === t.key ? 'border-accent font-medium text-ink' : 'border-transparent text-muted hover:text-ink')}>
          {t.label}
        </button>
      ))}
    </div>
  );
}
