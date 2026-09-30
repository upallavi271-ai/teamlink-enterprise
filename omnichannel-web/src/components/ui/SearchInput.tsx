import { Search } from 'lucide-react';
export function SearchInput({ value, onChange, placeholder = 'Search…' }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div className="relative">
      <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        className="h-10 w-full rounded-[10px] border border-line bg-surface pl-9 pr-3 text-sm focus-visible:outline-2 focus-visible:outline-accent sm:w-64" />
    </div>
  );
}
