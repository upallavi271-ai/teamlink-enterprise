import { NavLink } from 'react-router-dom';
import * as Icons from 'lucide-react';
import { PanelLeftClose, PanelLeft, Settings, LogOut, Building2 } from 'lucide-react';
import { SIDEBAR_NAV } from '@/app/navigation';
import { useUiStore } from '@/stores/uiStore';
import { useAuthStore } from '@/stores/authStore';
import { useOrgStore } from '@/stores/orgStore';
import { cn } from '@/lib/cn';

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const C = (Icons as unknown as Record<string, React.ComponentType<{ size?: number }>>)[name] ?? Icons.Circle;
  return <C size={size} />;
}

export function Sidebar() {
  const { sidebarCompact, toggleSidebar, mobileNavOpen, setMobileNav } = useUiStore();
  const signOut = useAuthStore((s) => s.signOut);
  const clearOrg = useOrgStore((s) => s.clear);
  const compact = sidebarCompact;

  const handleSignOut = () => { signOut(); clearOrg(); };

  return (
    <>
      {mobileNavOpen && <div className="fixed inset-0 z-30 bg-black/40 lg:hidden" onClick={() => setMobileNav(false)} aria-hidden />}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex flex-col bg-[var(--side)] text-[var(--side-ink)] transition-[width,transform] duration-200',
          compact ? 'w-[76px]' : 'w-[258px]',
          mobileNavOpen ? 'translate-x-0' : '-translate-x-full',
          'lg:translate-x-0',
        )}
      >
        <div className="flex items-center gap-2.5 px-4 py-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-accent font-display text-sm font-bold text-white">GS</div>
          {!compact && (
            <div className="min-w-0 leading-tight">
              <b className="block truncate font-display text-sm">Green Start</b>
              <span className="block truncate text-xs text-[var(--side-muted)]">Omnichannel marketing</span>
            </div>
          )}
          <button onClick={toggleSidebar} className="ml-auto hidden rounded-lg p-1.5 text-[var(--side-muted)] hover:bg-[var(--side-2)] lg:block" aria-label="Toggle sidebar">
            {compact ? <PanelLeft size={16} /> : <PanelLeftClose size={16} />}
          </button>
        </div>

        <nav className="flex-1 space-y-4 overflow-y-auto px-3 py-2">
          {SIDEBAR_NAV.map((group, gi) => (
            <div key={gi}>
              {group.title && !compact && (
                <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--side-muted)]">{group.title}</div>
              )}
              <div className="space-y-0.5">
                {group.items.map((item) => (
                  <NavLink
                    key={item.id}
                    to={item.path}
                    onClick={() => setMobileNav(false)}
                    title={compact ? item.label : undefined}
                    className={({ isActive }) => cn(
                      'flex items-center gap-3 rounded-[10px] px-2.5 py-2 text-sm transition-colors',
                      isActive ? 'bg-accent text-white' : 'text-[var(--side-ink)] hover:bg-[var(--side-2)]',
                      compact && 'justify-center',
                    )}
                  >
                    <span className="shrink-0"><Icon name={item.icon} /></span>
                    {!compact && <span className="flex-1 truncate">{item.label}</span>}
                    {!compact && item.badge && <span className="rounded-full bg-lime px-1.5 text-[10px] font-semibold text-[var(--side)]">{item.badge}</span>}
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>

        <div className="space-y-0.5 border-t border-[var(--side-2)] p-3">
          <NavLink to="/app/organizations" className={cn('flex w-full items-center gap-3 rounded-[10px] px-2.5 py-2 text-sm text-[var(--side-ink)] hover:bg-[var(--side-2)]', compact && 'justify-center')} title="Switch Organization">
            <Building2 size={18} />{!compact && <span>Switch Organization</span>}
          </NavLink>
          <NavLink to="/app/settings" className={cn('flex w-full items-center gap-3 rounded-[10px] px-2.5 py-2 text-sm text-[var(--side-ink)] hover:bg-[var(--side-2)]', compact && 'justify-center')} title="Settings">
            <Settings size={18} />{!compact && <span>Settings</span>}
          </NavLink>
          <button onClick={handleSignOut} className={cn('flex w-full items-center gap-3 rounded-[10px] px-2.5 py-2 text-sm text-[var(--red)] hover:bg-[var(--side-2)]', compact && 'justify-center')} title="Logout">
            <LogOut size={18} />{!compact && <span>Logout</span>}
          </button>
        </div>
      </aside>
    </>
  );
}
