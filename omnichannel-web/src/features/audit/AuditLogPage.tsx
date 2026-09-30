import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Info, Download } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { SearchInput } from '@/components/ui/SearchInput';
import { Pagination } from '@/components/ui/Pagination';
import { LoadingState, EmptyState, ErrorState } from '@/components/feedback/states';
import { useListParams } from '@/features/_shared/useListParams';
import { useCan } from '@/features/auth/useCan';
import { auditService } from '@/services/audit/audit.service';
import { useOrgStore } from '@/stores/orgStore';
import { toast } from '@/components/toast/toastStore';
import { RefreshButton } from '@/components/ui/RefreshButton';
import { downloadCsv } from '@/lib/csv';
import { collectAll } from '@/lib/collectAll';
import type { AuditLogEntry } from '@/types';

// Colour the action by its domain prefix so the trail scans quickly.
const actionTone = (action: string): 'green' | 'blue' | 'orange' | 'red' | 'violet' | 'neutral' => {
  const d = action.split('.')[0];
  if (d === 'auth') return 'blue';
  if (d === 'team' || d === 'role') return 'violet';
  if (d === 'workspace') return 'orange';
  if (d === 'integration') return 'green';
  if (action.includes('delete') || action.includes('remove')) return 'red';
  return 'neutral';
};
const prettyAction = (a: string) => a.replace(/_/g, ' ').replace('.', ' · ');
const initials = (name: string) => name.split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase();

export function AuditLogPage() {
  const orgId = useOrgStore((s) => s.currentWorkspaceId) ?? '';
  const canView = useCan('audit.view');
  const lp = useListParams({ pageSize: 25 });
  const [detail, setDetail] = useState<AuditLogEntry | null>(null);
  const [exporting, setExporting] = useState(false);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['audit', orgId, lp.params], queryFn: () => auditService.list(orgId, lp.params), enabled: !!orgId && canView,
  });
  const { data: actions } = useQuery({
    queryKey: ['audit-actions', orgId], queryFn: () => auditService.actions(orgId), enabled: !!orgId && canView,
  });

  if (!canView) {
    return (
      <div>
        <PageHeader title="Audit Log" subtitle="A record of who did what, and when" />
        <Card><EmptyState title="No access" detail="You need the audit.view permission to read the audit log." /></Card>
      </div>
    );
  }

  const rows = data?.items ?? [];
  const exportCsv = async () => {
    setExporting(true);
    try {
      const all = await collectAll((page, pageSize) => auditService.list(orgId, { ...lp.params, page, pageSize }));
      downloadCsv('audit-log.csv', all.map((r) => ({
        When: new Date(r.createdAt).toISOString(), Actor: r.actor?.name ?? 'System', ActorEmail: r.actor?.email ?? '',
        Action: r.action, Summary: r.summary, Entity: r.entityType ?? '', EntityId: r.entityId ?? '', IP: r.ipAddress ?? '',
      })));
      toast.success(all.length ? `Exported ${all.length} entr${all.length === 1 ? 'y' : 'ies'} to CSV` : 'Nothing to export');
    } catch (e) {
      toast.error((e as Error)?.message ?? 'Export failed');
    } finally {
      setExporting(false);
    }
  };
  const setDate = (key: 'from' | 'to', v: string) => {
    if (!v) { lp.setFilter(key, undefined); return; }
    // from = start of the chosen day; to = start of the next day (exclusive).
    const d = new Date(v + 'T00:00:00');
    if (key === 'to') d.setDate(d.getDate() + 1);
    lp.setFilter(key, d.toISOString());
  };
  const dateValue = (key: 'from' | 'to') => {
    const iso = lp.filters[key];
    if (!iso) return '';
    const d = new Date(iso);
    if (key === 'to') d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  };

  return (
    <div>
      <PageHeader title="Audit Log" subtitle="A record of who did what, and when — read-only"
        actions={<><RefreshButton keys={['audit', 'audit-actions']} /><Button variant="secondary" size="sm" onClick={exportCsv} loading={exporting} disabled={(data?.total ?? 0) === 0}><Download size={15} /> Export</Button></>} />
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
          <SearchInput value={lp.search} onChange={lp.setSearch} placeholder="Search summary…" />
          <Select className="h-10 w-auto" value={lp.filters.action ?? ''} onChange={(e) => lp.setFilter('action', e.target.value)}>
            <option value="">All actions</option>
            {(actions ?? []).map((a) => <option key={a} value={a}>{prettyAction(a)}</option>)}
          </Select>
          <label className="flex items-center gap-1.5 text-xs text-muted">From
            <Input type="date" className="h-10 w-auto" value={dateValue('from')} onChange={(e) => setDate('from', e.target.value)} />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-muted">To
            <Input type="date" className="h-10 w-auto" value={dateValue('to')} onChange={(e) => setDate('to', e.target.value)} />
          </label>
        </div>

        {isLoading ? <LoadingState /> : isError ? <ErrorState onRetry={() => refetch()} />
          : rows.length === 0 ? <EmptyState title="No audit entries" detail="Security-relevant actions — sign-ins, role changes, workspace and integration updates — will appear here." />
          : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead><tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                <th className="px-4 py-3">When</th><th className="px-4 py-3">Actor</th><th className="px-4 py-3">Action</th>
                <th className="px-4 py-3">Summary</th><th className="px-4 py-3"></th>
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-line last:border-0 hover:bg-surface-2">
                    <td className="px-4 py-3 text-muted whitespace-nowrap">{new Date(r.createdAt).toLocaleString()}</td>
                    <td className="px-4 py-3">
                      {r.actor ? (
                        <div className="flex items-center gap-2">
                          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-surface-2 text-[10px] font-medium text-muted">{initials(r.actor.name)}</span>
                          <span className="text-ink" title={r.actor.email}>{r.actor.name}</span>
                        </div>
                      ) : <span className="text-muted">System</span>}
                    </td>
                    <td className="px-4 py-3"><Badge tone={actionTone(r.action)}>{prettyAction(r.action)}</Badge></td>
                    <td className="px-4 py-3 text-ink">{r.summary}</td>
                    <td className="px-4 py-3 text-right">
                      {(r.metadata || r.ipAddress || r.entityId) && (
                        <Button variant="ghost" size="sm" aria-label="Details" onClick={() => setDetail(r)}><Info size={15} /></Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination page={lp.page} pageSize={lp.pageSize} total={data?.total ?? 0} onPage={lp.setPage} />
          </div>
        )}
      </Card>

      {detail && (
        <Modal open onClose={() => setDetail(null)} title="Audit entry" size="md"
          footer={<Button variant="secondary" size="sm" onClick={() => setDetail(null)}>Close</Button>}>
          <dl className="space-y-2 text-sm">
            <Row label="When" value={new Date(detail.createdAt).toLocaleString()} />
            <Row label="Actor" value={detail.actor ? `${detail.actor.name} (${detail.actor.email})` : 'System'} />
            <Row label="Action" value={prettyAction(detail.action)} />
            <Row label="Summary" value={detail.summary} />
            {detail.entityType && <Row label="Entity" value={`${detail.entityType}${detail.entityId ? ` · ${detail.entityId}` : ''}`} />}
            {detail.ipAddress && <Row label="IP address" value={detail.ipAddress} />}
          </dl>
          {detail.metadata && Object.keys(detail.metadata).length > 0 && (
            <div className="mt-3">
              <div className="mb-1 text-xs uppercase tracking-wide text-muted">Metadata</div>
              <pre className="overflow-x-auto rounded-lg border border-line bg-surface-2 p-3 text-xs text-ink">{JSON.stringify(detail.metadata, null, 2)}</pre>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3">
      <dt className="w-24 shrink-0 font-medium text-muted">{label}</dt>
      <dd className="text-ink break-words">{value}</dd>
    </div>
  );
}
