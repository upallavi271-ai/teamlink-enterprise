import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Menu, Bell, ChevronDown, Search } from 'lucide-react';
import { useUiStore } from '@/stores/uiStore';
import { useOrgStore, useCurrentWorkspace } from '@/stores/orgStore';
import { useAuthStore } from '@/stores/authStore';
import { initialsOf } from '@/lib/format';
import { cn } from '@/lib/cn';

function useOutsideClose(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [onClose]);
  return ref;
}

export function Header({ title }: { title: string }) {
  const setMobileNav = useUiStore((s) => s.setMobileNav);
  const { workspaces, switchWorkspace } = useOrgStore();
  const current = useCurrentWorkspace();
  const user = useAuthStore((s) => s.user);
  const signOut = useAuthStore((s) => s.signOut);
  const clearOrg = useOrgStore((s) => s.clear);
  const navigate = useNavigate();

  const [wsOpen, setWsOpen] = useState(false);
  const [userOpen, setUserOpen] = useState(false);
  const [term, setTerm] = useState('');
  const wsRef = useOutsideClose(() => setWsOpen(false));
  const userRef = useOutsideClose(() => setUserOpen(false));

  /**
   * Switching tenant is a full reload, the same as entering an organization from
   * the Organizations page. Swapping the id in place kept the previous
   * workspace's permission set (UI gating decided by the wrong role) and every
   * cached query whose key does not carry the workspace id.
   */
  const enterWorkspace = (id: string) => {
    switchWorkspace(id);
    window.location.assign(`${import.meta.env.BASE_URL}app/dashboard`);
  };

  const onSearch = (e: React.FormEvent) => { e.preventDefault(); if (term.trim()) navigate(`/app/crm/customers?q=${encodeURIComponent(term.trim())}`); };

  return (
    <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-line bg-surface/95 px-4 backdrop-blur">
      <button onClick={() => setMobileNav(true)} className="rounded-lg p-2 text-muted hover:bg-surface-2 lg:hidden" aria-label="Open menu"><Menu size={20} /></button>

      <div className="hidden text-sm text-muted sm:block">Green Start / <b className="text-ink">{title}</b></div>

      <form onSubmit={onSearch} className="relative ml-auto hidden md:block">
        <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
        <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search customers…"
          className="h-9 w-56 rounded-[10px] border border-line bg-surface-2 pl-8 pr-3 text-sm focus-visible:outline-2 focus-visible:outline-accent" />
      </form>

      <div ref={wsRef} className="relative">
        <button onClick={() => setWsOpen((o) => !o)} className="flex h-9 items-center gap-2 rounded-[10px] border border-line px-3 text-sm hover:bg-surface-2">
          <span className="flex h-5 w-5 items-center justify-center rounded bg-accent-soft text-[10px] font-semibold text-accent-2">{current?.logoText ?? 'GS'}</span>
          <span className="max-w-[140px] truncate">{current?.name ?? 'Select workspace'}</span>
          <ChevronDown size={14} className="text-muted" />
        </button>
        {wsOpen && (
          <div className="absolute right-0 mt-2 w-60 rounded-card border border-line bg-surface p-1 shadow-card">
            {workspaces.map((w) => (
              <button key={w.id} onClick={() => { setWsOpen(false); if (w.id !== current?.id) enterWorkspace(w.id); }}
                className={cn('flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-surface-2', w.id === current?.id && 'bg-surface-2')}>
                <span className="flex h-5 w-5 items-center justify-center rounded bg-accent-soft text-[10px] font-semibold text-accent-2">{w.logoText}</span>
                <span className="flex-1 truncate">{w.name}</span>
                <span className="text-xs text-muted">{w.role}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <button className="relative rounded-lg p-2 text-muted hover:bg-surface-2" aria-label="Notifications"><Bell size={19} /></button>

      <div ref={userRef} className="relative">
        <button onClick={() => setUserOpen((o) => !o)} className="flex h-9 items-center gap-2 rounded-[10px] px-1.5 hover:bg-surface-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold text-white" style={{ background: user?.avatarColor ?? 'var(--accent)' }}>{initialsOf(user?.name ?? 'GS')}</span>
          <span className="hidden text-sm sm:block">{user?.name ?? 'User'}</span>
          <ChevronDown size={14} className="text-muted" />
        </button>
        {userOpen && (
          <div className="absolute right-0 mt-2 w-48 rounded-card border border-line bg-surface p-1 shadow-card">
            <div className="border-b border-line px-3 py-2 text-xs text-muted">{user?.email}</div>
            <button onClick={() => { setUserOpen(false); navigate('/app/settings'); }} className="w-full rounded-lg px-2.5 py-2 text-left text-sm hover:bg-surface-2">Settings</button>
            <button onClick={() => { signOut(); clearOrg(); }} className="w-full rounded-lg px-2.5 py-2 text-left text-sm text-red hover:bg-surface-2">Sign out</button>
          </div>
        )}
      </div>
    </header>
  );
}
