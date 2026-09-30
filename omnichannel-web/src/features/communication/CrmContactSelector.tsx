import { useMemo, useState, type ChangeEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Users, Upload, Sheet, Plus, Columns3, RefreshCw, FileDown, Pencil, Trash2,
  Check, UserPlus, ChevronLeft, ChevronRight,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { Field, Input } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { Checkbox } from '@/components/ui/Checkbox';
import { SearchInput } from '@/components/ui/SearchInput';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { LoadingState, EmptyState, ErrorState } from '@/components/feedback/states';
import { customersService } from '@/services/crm/customers.service';
import { agentsService } from '@/services/crm/agents.service';
import { toast } from '@/components/toast/toastStore';
import { LEAD_STAGES, LEAD_STATUSES, SOURCES, cap } from '@/features/crm/crmLabels';
import type { Channel, Customer, CustomerInput, LeadStage, LeadStatus } from '@/types';

type ColKey = 'phone' | 'source' | 'campaign' | 'email' | 'createdAt' | 'platformId' | 'leadStage' | 'leadStatus' | 'assign';
const COLUMNS: { key: ColKey; label: string }[] = [
  { key: 'phone', label: 'Phone Number' },
  { key: 'source', label: 'Source' },
  { key: 'campaign', label: 'Campaign' },
  { key: 'email', label: 'Email Address' },
  { key: 'createdAt', label: 'Created On' },
  { key: 'platformId', label: 'Platform ID' },
  { key: 'leadStage', label: 'Lead Stage' },
  { key: 'leadStatus', label: 'Lead Status' },
  { key: 'assign', label: 'Assign' },
];

const xmlEsc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Real Excel SpreadsheetML (.xls) — a genuine spreadsheet, not a renamed CSV. */
function buildSpreadsheet(rows: Customer[]): string {
  const headers = ['Name', 'Phone', 'Email', 'Source', 'Campaign', 'Platform ID', 'Lead Stage', 'Lead Status', 'Created On'];
  const cell = (v: string) => `<Cell><Data ss:Type="String">${xmlEsc(v ?? '')}</Data></Cell>`;
  const row = (cells: string[]) => `<Row>${cells.map(cell).join('')}</Row>`;
  const body = rows.map((c) => row([
    c.name ?? '', c.phone ?? '', c.email ?? '', c.source ?? '', c.campaignName ?? '',
    c.platformId ?? '', c.leadStage ?? '', c.leadStatus ?? '', new Date(c.createdAt).toLocaleString(),
  ])).join('');
  return `<?xml version="1.0"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Worksheet ss:Name="Customers"><Table>${row(headers)}${body}</Table></Worksheet></Workbook>`;
}

function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim().length > 0);
  if (!lines.length) return { headers: [], rows: [] };
  const split = (line: string): string[] => {
    const out: string[] = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') q = false; else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out.map((c) => c.trim());
  };
  return { headers: split(lines[0]).map((h) => h.toLowerCase()), rows: lines.slice(1).map(split) };
}

export function CrmContactSelector({ orgId, channel, onClose, onUse }: {
  orgId: string; channel: Channel; onClose: () => void; onUse: (addresses: string[], count: number) => void;
}) {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [visible, setVisible] = useState<Set<ColKey>>(new Set(COLUMNS.map((c) => c.key)));
  const [colsOpen, setColsOpen] = useState(false);
  const [sel, setSel] = useState<Map<string, Customer>>(new Map());
  const [editing, setEditing] = useState<Customer | 'new' | null>(null);
  const [assignFor, setAssignFor] = useState<Customer | null>(null);
  const [toDelete, setToDelete] = useState<Customer | null>(null);
  const [importing, setImporting] = useState(false);

  const params = useMemo(() => ({ search: search || undefined, page, pageSize }), [search, page, pageSize]);
  const q = useQuery({ queryKey: ['crm-picker', orgId, params], queryFn: () => customersService.list(orgId, params), enabled: !!orgId });
  const agentsQ = useQuery({ queryKey: ['agents', orgId], queryFn: () => agentsService.list(orgId), enabled: !!orgId });
  const refresh = () => qc.invalidateQueries({ queryKey: ['crm-picker', orgId] });

  const saveM = useMutation({
    mutationFn: (v: { id?: string; input: CustomerInput }) =>
      v.id ? customersService.update(orgId, v.id, v.input) : customersService.create(orgId, v.input),
    onSuccess: () => refresh(),
  });
  const patchM = useMutation({
    mutationFn: (v: { id: string; patch: Partial<CustomerInput> }) => customersService.update(orgId, v.id, v.patch),
    onSuccess: () => refresh(),
  });
  const delM = useMutation({ mutationFn: (id: string) => customersService.remove(orgId, id), onSuccess: () => refresh() });

  const rows = q.data?.items ?? [];
  const total = q.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const addrOf = (c: Customer) => (channel === 'email' ? c.email ?? '' : c.phone ?? '');
  const show = (k: ColKey) => visible.has(k);

  const toggleRow = (c: Customer) => setSel((m) => { const n = new Map(m); n.has(c.id) ? n.delete(c.id) : n.set(c.id, c); return n; });
  const allOnPage = rows.length > 0 && rows.every((c) => sel.has(c.id));
  const togglePage = () => setSel((m) => {
    const n = new Map(m);
    if (allOnPage) rows.forEach((c) => n.delete(c.id)); else rows.forEach((c) => n.set(c.id, c));
    return n;
  });

  const use = () => {
    const seen = new Set<string>(); const out: string[] = [];
    for (const c of sel.values()) {
      const raw = addrOf(c).trim();
      if (!raw) continue;
      const a = channel === 'email'
        ? (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw) ? raw.toLowerCase() : '')
        : (raw.replace(/[^\d]/g, '').length >= 10 ? raw.replace(/[^\d]/g, '') : '');
      if (a && !seen.has(a)) { seen.add(a); out.push(a); }
    }
    if (!out.length) {
      toast.error(channel === 'email' ? 'None of the selected contacts have a valid email.' : 'None of the selected contacts have a valid phone number.');
      return;
    }
    onUse(out, out.length);
  };

  const exportExcel = async () => {
    try {
      const all = await customersService.all(orgId, { search: search || undefined });
      const blob = new Blob([buildSpreadsheet(all)], { type: 'application/vnd.ms-excel' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = `customers-${new Date().toISOString().slice(0, 10)}.xls`; a.click();
      URL.revokeObjectURL(a.href);
      toast.success(`Exported ${all.length} customers`);
    } catch (e) { toast.error((e as Error)?.message ?? 'Export failed'); }
  };

  const onImport = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; e.target.value = '';
    if (!file) return;
    setImporting(true);
    try {
      const { headers, rows: data } = parseCsv(await file.text());
      const find = (names: string[]) => headers.findIndex((h) => names.includes(h));
      const iName = find(['name', 'full name', 'customer name', 'fullname']);
      const iPhone = find(['phone', 'mobile', 'phone number', 'mobile number', 'number']);
      const iEmail = find(['email', 'email address', 'e-mail']);
      if (iName === -1 && iPhone === -1) { toast.error('CSV needs at least a “name” or “mobile” column.'); return; }
      let ok = 0, skipped = 0;
      for (const r of data) {
        const name = (iName >= 0 ? r[iName] : '') || (iPhone >= 0 ? r[iPhone] : '');
        if (!name) { skipped++; continue; }
        try {
          await customersService.create(orgId, {
            name,
            phone: iPhone >= 0 ? r[iPhone] || undefined : undefined,
            email: iEmail >= 0 ? r[iEmail] || undefined : undefined,
            source: 'CSV Import', leadStage: 'new', leadStatus: 'active',
          });
          ok++;
        } catch { skipped++; }
      }
      refresh();
      toast.success(`Imported ${ok} contact${ok === 1 ? '' : 's'}${skipped ? ` · ${skipped} skipped` : ''}`);
    } catch { toast.error('Could not read that CSV.'); }
    finally { setImporting(false); }
  };

  // A nested dialog owns Escape/backdrop while it is open, so the outer modal
  // does not close underneath it.
  const subOpen = !!editing || !!assignFor || !!toDelete;

  return (
    <Modal open onClose={() => { if (!subOpen) onClose(); }} size="xl"
      title="CRM Contact Selector"
      footer={<>
        <span className="mr-auto text-xs text-muted">{sel.size} selected</span>
        <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
        <Button size="sm" disabled={sel.size === 0} onClick={use}><Check size={15} /> Use {sel.size || ''} contact{sel.size === 1 ? '' : 's'}</Button>
      </>}>
      <div className="space-y-3">
        {/* Header + primary actions */}
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <Users size={18} className="text-accent" />
            <div>
              <div className="text-sm font-semibold text-ink">Customers</div>
              <div className="text-xs text-muted">Manage leads and view captured data.</div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-[10px] border border-line bg-surface px-3 py-2 text-sm text-ink hover:bg-surface-2">
              <Upload size={15} /> {importing ? 'Importing…' : 'Import Data'}
              <input type="file" accept=".csv,text/csv" hidden disabled={importing} onChange={onImport} />
            </label>
            <Button variant="secondary" size="md" onClick={() => toast.info('Google Sheets sync isn’t configured on the server yet.')}><Sheet size={15} /> Google Sheets</Button>
            <Button size="md" onClick={() => setEditing('new')}><Plus size={15} /> Add Customer</Button>
          </div>
        </div>

        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Search…" />
          <div className="relative">
            <Button variant="secondary" size="sm" onClick={() => setColsOpen((o) => !o)}><Columns3 size={15} /> Manage Columns</Button>
            {colsOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setColsOpen(false)} />
                <div className="absolute left-0 z-20 mt-1 w-56 rounded-[10px] border border-line bg-surface p-2 shadow-lg">
                  {COLUMNS.map((c) => (
                    <label key={c.key} className="flex items-center gap-2 px-1 py-1 text-sm text-ink">
                      <Checkbox checked={visible.has(c.key)} onChange={() => setVisible((s) => {
                        const n = new Set(s); n.has(c.key) ? n.delete(c.key) : n.add(c.key); return n;
                      })} /> {c.label}
                    </label>
                  ))}
                </div>
              </>
            )}
          </div>
          <Button variant="secondary" size="sm" onClick={() => { refresh(); toast.success('Refreshed'); }}><RefreshCw size={15} /> Refresh</Button>
          <Button variant="secondary" size="sm" onClick={exportExcel}><FileDown size={15} /> Export Excel</Button>
        </div>

        {/* Table */}
        {q.isLoading ? <LoadingState /> : q.isError ? <ErrorState onRetry={() => q.refetch()} />
          : rows.length === 0 ? <EmptyState title="No customers" detail="Add a contact or import a CSV to get started." />
          : (
            <div className="overflow-x-auto rounded-[10px] border border-line">
              <table className="w-full min-w-[900px] text-sm">
                <thead className="bg-surface-2 text-xs uppercase text-muted">
                  <tr>
                    <th className="sticky left-0 z-10 bg-surface-2 px-3 py-2"><Checkbox checked={allOnPage} onChange={togglePage} aria-label="Select page" /></th>
                    <th className="sticky left-12 z-10 border-r border-line bg-surface-2 px-3 py-2 text-left">Customer Name</th>
                    {show('phone') && <th className="px-3 py-2 text-left">Phone Number</th>}
                    {show('source') && <th className="px-3 py-2 text-left">Source</th>}
                    {show('campaign') && <th className="px-3 py-2 text-left">Campaign</th>}
                    {show('email') && <th className="px-3 py-2 text-left">Email Address</th>}
                    {show('createdAt') && <th className="px-3 py-2 text-left">Created On</th>}
                    {show('platformId') && <th className="px-3 py-2 text-left">Platform ID</th>}
                    {show('leadStage') && <th className="px-3 py-2 text-left">Lead Stage</th>}
                    {show('leadStatus') && <th className="px-3 py-2 text-left">Lead Status</th>}
                    {show('assign') && <th className="px-3 py-2 text-left">Assign</th>}
                    <th className="sticky right-0 z-10 border-l border-line bg-surface-2 px-3 py-2 text-center">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => (
                    <tr key={c.id} className="group border-t border-line hover:bg-surface-2">
                      <td className="sticky left-0 z-10 bg-surface px-3 py-2 group-hover:bg-surface-2"><Checkbox checked={sel.has(c.id)} onChange={() => toggleRow(c)} aria-label={`Select ${c.name}`} /></td>
                      <td className="sticky left-12 z-10 whitespace-nowrap border-r border-line bg-surface px-3 py-2 text-ink group-hover:bg-surface-2">{c.name}</td>
                      {show('phone') && <td className="px-3 py-2 text-muted">{c.phone ?? '—'}</td>}
                      {show('source') && <td className="px-3 py-2">{c.source ? <Badge>{c.source}</Badge> : '—'}</td>}
                      {show('campaign') && <td className="px-3 py-2 text-muted">{c.campaignName ?? '—'}</td>}
                      {show('email') && <td className="px-3 py-2 text-muted">{c.email ?? <span className="italic">Empty</span>}</td>}
                      {show('createdAt') && <td className="px-3 py-2 text-muted">{new Date(c.createdAt).toLocaleString()}</td>}
                      {show('platformId') && <td className="px-3 py-2 text-muted">{c.platformId ?? '—'}</td>}
                      {show('leadStage') && (
                        <td className="px-3 py-2">
                          <Select className="h-8 !w-32" value={c.leadStage}
                            onChange={(e) => patchM.mutateAsync({ id: c.id, patch: { leadStage: e.target.value as LeadStage } })
                              .then(() => toast.success('Lead stage updated')).catch(() => toast.error('Update failed'))}>
                            {LEAD_STAGES.map((s) => <option key={s} value={s}>{cap(s)}</option>)}
                          </Select>
                        </td>
                      )}
                      {show('leadStatus') && (
                        <td className="px-3 py-2">
                          <Select className="h-8 !w-32" value={c.leadStatus}
                            onChange={(e) => patchM.mutateAsync({ id: c.id, patch: { leadStatus: e.target.value as LeadStatus } })
                              .then(() => toast.success('Lead status updated')).catch(() => toast.error('Update failed'))}>
                            {LEAD_STATUSES.map((s) => <option key={s} value={s}>{cap(s)}</option>)}
                          </Select>
                        </td>
                      )}
                      {show('assign') && (
                        <td className="px-3 py-2">
                          <Button variant="secondary" size="sm" onClick={() => setAssignFor(c)}>
                            <UserPlus size={14} /> {agentsQ.data?.find((a) => a.id === c.assignedAgentId)?.name ?? 'Assign Agent'}
                          </Button>
                        </td>
                      )}
                      <td className="sticky right-0 z-10 border-l border-line bg-surface px-3 py-2 group-hover:bg-surface-2">
                        <div className="flex justify-center gap-1">
                          <button type="button" title="Edit customer" aria-label={`Edit ${c.name}`}
                            className="rounded-lg border border-line p-1.5 text-accent hover:bg-accent-soft"
                            onClick={() => setEditing(c)}><Pencil size={15} /></button>
                          <button type="button" title="Delete customer" aria-label={`Delete ${c.name}`}
                            className="rounded-lg border border-line p-1.5 text-red hover:bg-red/10"
                            onClick={() => setToDelete(c)}><Trash2 size={15} /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

        {/* Footer / pagination */}
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
          <span>Page {page} of {pages} · Total {total}</span>
          <div className="flex items-center gap-2">
            <Select className="h-8 !w-20" value={String(pageSize)} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}>
              {[10, 20, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
            </Select>
            <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} aria-label="Previous"><ChevronLeft size={15} /></Button>
            <Button variant="secondary" size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)} aria-label="Next"><ChevronRight size={15} /></Button>
          </div>
        </div>

        <p className="text-xs text-muted">
          Only contacts with a valid {channel === 'email' ? 'email address' : 'phone number'} are included in the send.
        </p>
      </div>

      {editing && (
        <CustomerForm customer={editing === 'new' ? null : editing} saving={saveM.isPending}
          onClose={() => setEditing(null)}
          onSave={(input) => saveM.mutateAsync({ id: editing === 'new' ? undefined : editing.id, input })
            .then(() => { toast.success(editing === 'new' ? 'Customer added' : 'Customer updated'); setEditing(null); })
            .catch((e) => toast.error(e?.message ?? 'Save failed'))} />
      )}

      {assignFor && (
        <Modal open onClose={() => setAssignFor(null)} title="Manage Agents" size="sm"
          footer={<Button variant="secondary" size="sm" onClick={() => setAssignFor(null)}>Close</Button>}>
          <p className="mb-2 text-xs text-muted">Assign an agent to <b className="text-ink">{assignFor.name}</b>.</p>
          <div className="divide-y divide-line rounded-[10px] border border-line">
            {(agentsQ.data ?? []).map((a) => {
              const on = assignFor.assignedAgentId === a.id;
              return (
                <div key={a.id} className="flex items-center justify-between gap-2 px-3 py-2">
                  <span className="text-sm text-ink">{a.name}</span>
                  <Button variant={on ? 'secondary' : 'primary'} size="sm"
                    onClick={() => patchM.mutateAsync({ id: assignFor.id, patch: { assignedAgentId: on ? undefined : a.id } })
                      .then(() => { toast.success(on ? 'Agent removed' : 'Agent assigned'); setAssignFor(null); })
                      .catch(() => toast.error('Could not update assignment'))}>
                    {on ? <><Check size={14} /> Assigned</> : <><Plus size={14} /> Assign</>}
                  </Button>
                </div>
              );
            })}
            {(agentsQ.data ?? []).length === 0 && <div className="px-3 py-4 text-center text-xs text-muted">No agents available.</div>}
          </div>
        </Modal>
      )}

      <ConfirmDialog open={!!toDelete} title="Delete customer" danger confirmLabel="Delete" loading={delM.isPending}
        message={`Delete "${toDelete?.name}"? This cannot be undone.`}
        onConfirm={() => toDelete && delM.mutateAsync(toDelete.id)
          .then(() => { toast.success('Customer deleted'); setSel((m) => { const n = new Map(m); n.delete(toDelete.id); return n; }); setToDelete(null); })
          .catch(() => toast.error('Delete failed'))}
        onClose={() => setToDelete(null)} />
    </Modal>
  );
}

// ── Add / Edit customer ──────────────────────────────────────────────────────
function CustomerForm({ customer, saving, onClose, onSave }: {
  customer: Customer | null; saving: boolean; onClose: () => void; onSave: (input: CustomerInput) => void;
}) {
  const [f, setF] = useState<CustomerInput>({
    name: customer?.name ?? '',
    phone: customer?.phone ?? '',
    email: customer?.email ?? '',
    platformId: customer?.platformId ?? '',
    source: customer?.source ?? 'Manual',
    campaignName: customer?.campaignName,
    leadStage: customer?.leadStage ?? 'new',
    leadStatus: customer?.leadStatus ?? 'active',
    assignedAgentId: customer?.assignedAgentId,
  });
  const [err, setErr] = useState('');
  const set = <K extends keyof CustomerInput>(k: K, v: CustomerInput[K]) => setF((p) => ({ ...p, [k]: v }));

  const submit = () => {
    if (!f.name.trim()) { setErr('Full name is required.'); return; }
    if (!f.phone?.trim() && !f.email?.trim()) { setErr('Add a phone number or an email address.'); return; }
    setErr('');
    onSave({ ...f, name: f.name.trim(), phone: f.phone?.trim() || undefined, email: f.email?.trim() || undefined, platformId: f.platformId?.trim() || undefined });
  };

  return (
    <Modal open onClose={onClose} title={customer ? 'Edit Customer' : 'Add New Customer'} size="md"
      footer={<><Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
        <Button size="sm" loading={saving} onClick={submit}>Save Customer</Button></>}>
      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Full Name" error={err && !f.name.trim() ? err : undefined}>
            <Input value={f.name} invalid={!!err && !f.name.trim()} onChange={(e) => set('name', e.target.value)} placeholder="Rahul Sharma" />
          </Field>
          <Field label="Phone"><Input value={f.phone ?? ''} onChange={(e) => set('phone', e.target.value)} placeholder="+91…" /></Field>
          <Field label="Email Address"><Input value={f.email ?? ''} onChange={(e) => set('email', e.target.value)} placeholder="name@example.com" /></Field>
          <Field label="Platform ID"><Input value={f.platformId ?? ''} onChange={(e) => set('platformId', e.target.value)} placeholder="e.g. FB Lead ID" /></Field>
        </div>

        <div className="border-t border-line pt-3">
          <div className="mb-2 text-sm font-medium text-ink">Additional Info</div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Source">
              <Select value={f.source} onChange={(e) => set('source', e.target.value)}>
                {['Manual', ...SOURCES].map((s) => <option key={s} value={s}>{s}</option>)}
              </Select>
            </Field>
            <Field label="Lead Stage">
              <Select value={f.leadStage} onChange={(e) => set('leadStage', e.target.value as LeadStage)}>
                {LEAD_STAGES.map((s) => <option key={s} value={s}>{cap(s)}</option>)}
              </Select>
            </Field>
            <Field label="Lead Status">
              <Select value={f.leadStatus} onChange={(e) => set('leadStatus', e.target.value as LeadStatus)}>
                {LEAD_STATUSES.map((s) => <option key={s} value={s}>{cap(s)}</option>)}
              </Select>
            </Field>
          </div>
        </div>

        {err && f.name.trim() && <p className="text-xs text-red">{err}</p>}
        <p className="text-xs text-muted">Saved contacts appear in the table immediately and in CRM → All Customers.</p>
      </div>
    </Modal>
  );
}
