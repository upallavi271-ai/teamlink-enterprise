import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar } from '@/components/layout/Sidebar';
import { Header } from '@/components/layout/Header';
import { ErrorBoundary } from '@/components/feedback/ErrorBoundary';
import { useUiStore } from '@/stores/uiStore';
import { NAV_ITEMS } from '@/app/navigation';
import { cn } from '@/lib/cn';

export function AppLayout() {
  const compact = useUiStore((s) => s.sidebarCompact);
  const { pathname } = useLocation();
  const active = NAV_ITEMS.find((n) => pathname.startsWith(n.path));
  const title = active?.label ?? 'Green Start';

  return (
    <div className="min-h-screen bg-bg">
      <Sidebar />
      <div className={cn('flex min-h-screen flex-col transition-[margin] duration-200', compact ? 'lg:ml-[76px]' : 'lg:ml-[258px]')}>
        <Header title={title} />
        <main className="flex-1 p-4 sm:p-6">
          <ErrorBoundary><Outlet /></ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
