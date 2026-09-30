import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ChangeEvent, DragEvent } from 'react';
import {
  Check, Plus, Download, Upload, ArrowLeft, ArrowRight, AlertTriangle, CheckCircle2, Search,
} from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { useCan } from '@/features/auth/useCan';
import { useOrgStore } from '@/stores/orgStore';
import { Field, Input } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { LoadingState } from '@/components/feedback/states';
import { toast } from '@/components/toast/toastStore';
import { parseCsv } from '@/lib/csv';
import { customersService, type BulkImportResult } from '@/services/crm/customers.service';
import { LEAD_STAGES, LEAD_STATUSES, SOURCES, cap } from '../crmLabels';
import type { Agent, Customer, CustomerInput, LeadStage, LeadStatus } from '@/types';

// ── Add / Edit customer ──────────────────────────────────────────────────────
export function CustomerFormModal({ customer, saving, onClose, onSave }: {
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
    onSave({
      ...f, name: f.name.trim(),
      phone: f.phone?.trim() || undefined, email: f.email?.trim() || undefined,
      platformId: f.platformId?.trim() || undefined,
    });
  };

  return (
    <Modal open onClose={onClose} title={customer ? 'Edit Customer' : 'Add New Customer'} size="md"
      footer={<>
        <Button variant="secondary" size="sm" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button size="sm" loading={saving} onClick={submit}>Save Customer</Button>
      </>}>
      <div className="space-y-3">
        <p className="text-[11px] text-muted">Context: <span className="text-accent">Default</span></p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Full Name" error={err && !f.name.trim() ? err : undefined}>
            <Input value={f.name} invalid={!!err && !f.name.trim()} onChange={(e) => set('name', e.target.value)} placeholder="Rahul Sharma" autoFocus />
          </Field>
          <Field label="Phone"><Input value={f.phone ?? ''} onChange={(e) => set('phone', e.target.value)} placeholder="+91…" /></Field>
          <Field label="Email Address"><Input value={f.email ?? ''} onChange={(e) => set('email', e.target.value)} placeholder="name@example.com" /></Field>
          <Field label="Platform ID"><Input value={f.platformId ?? ''} onChange={(e) => set('platformId', e.target.value)} placeholder="e.g. FB Lead ID" /></Field>
        </div>

        <div className="border-t border-line pt-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium text-ink">Additional Info</span>
            <span className="text-[11px] text-muted">3 fields linked</span>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
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

        {customer && <ConsentSection customer={customer} />}

        {err && f.name.trim() && <p className="text-xs text-red">{err}</p>}
      </div>
    </Modal>
  );
}

// ── Marketing consent (DPDP) — record grant / withdrawal, show the history ──
function ConsentSection({ customer }: { customer: Customer }) {
  const qc = useQueryClient();
  const orgId = useOrgStore((s) => s.currentWorkspaceId) ?? '';
  const canEdit = useCan('customer.edit');
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const history = useQuery({ queryKey: ['customers', orgId, 'consents', customer.id], queryFn: () => customersService.consents(orgId, customer.id), enabled: !!orgId && open });
  const record = useMutation({
    mutationFn: (status: 'granted' | 'withdrawn') => customersService.recordConsent(orgId, customer.id, { status, source: 'manual', note: note.trim() || undefined }),
    onSuccess: (_c, status) => { toast.success(status === 'granted' ? 'Consent recorded' : 'Consent withdrawn — excluded from campaigns'); setNote(''); qc.invalidateQueries({ queryKey: ['customers', orgId] }); },
    onError: (e: Error) => toast.error(e?.message ?? 'Could not record consent'),
  });
  const status = customer.consentStatus ?? 'unknown';
  const tone = status === 'granted' ? 'green' : status === 'withdrawn' ? 'red' : 'neutral';
  const label = status === 'granted' ? 'Consent given' : status === 'withdrawn' ? 'Consent withdrawn' : 'No consent recorded';
  return (
    <div className="border-t border-line pt-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium text-ink">Marketing consent</span>
        <Badge tone={tone}>{label}</Badge>
      </div>
      <p className="text-[11px] text-muted">
        {status === 'withdrawn' ? 'This person is excluded from every campaign send until consent is recorded again.'
          : status === 'unknown' ? 'Nothing has been recorded. Record consent only when the person actually agreed (form, WhatsApp reply, signed note).'
          : 'Recorded consent is kept as an append-only history with time, source and who recorded it.'}
      </p>
      {canEdit && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Input className="h-9 flex-1" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note / evidence (optional), e.g. replied YES on WhatsApp" />
          <Button variant="secondary" size="sm" loading={record.isPending} onClick={() => record.mutate('granted')}>Record consent</Button>
          <Button variant="ghost" size="sm" loading={record.isPending} onClick={() => record.mutate('withdrawn')}>Withdraw</Button>
        </div>
      )}
      <button type="button" className="mt-2 text-xs text-accent hover:underline" onClick={() => setOpen((o) => !o)}>{open ? 'Hide history' : 'Show history'}</button>
      {open && (
        history.isLoading ? <p className="text-xs text-muted">Loading…</p>
        : !history.data?.length ? <p className="text-xs text-muted">No consent events yet.</p>
        : (
          <ul className="mt-1 divide-y divide-line rounded-[10px] border border-line text-xs">
            {history.data.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2 px-3 py-1.5">
                <Badge tone={r.status === 'granted' ? 'green' : 'red'}>{r.status}</Badge>
                <span className="text-ink">{r.purpose}</span>
                <span className="text-muted">via {r.source}</span>
                {r.note && <span className="text-muted">· {r.note}</span>}
                <span className="ml-auto text-muted">{new Date(r.occurredAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )
      )}
    </div>
  );
}

// ── Assign agent ─────────────────────────────────────────────────────────────
export function AssignAgentModal({ customer, agents, saving, onAssign, onClose }: {
  customer: Customer; agents: Agent[]; saving: boolean;
  onAssign: (agentId: string | undefined) => void; onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const list = useMemo(() => agents.filter((a) => a.name.toLowerCase().includes(q.toLowerCase())), [agents, q]);
  return (
    <Modal open onClose={onClose} title="Manage Agents" size="sm"
      footer={<Button variant="secondary" size="sm" onClick={onClose}>Close</Button>}>
      <div className="space-y-3">
        <p className="text-xs text-muted">Assign an agent to <b className="text-ink">{customer.name}</b>.</p>
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search agents…" className="pl-8" />
        </div>
        <div className="max-h-72 divide-y divide-line overflow-y-auto rounded-[10px] border border-line">
          {list.map((a) => {
            const on = customer.assignedAgentId === a.id;
            return (
              <div key={a.id} className="flex items-center justify-between gap-2 px-3 py-2">
                <span className="flex items-center gap-2 text-sm text-ink">
                  <span className="grid h-7 w-7 place-items-center rounded-full bg-accent-soft text-[11px] font-semibold text-accent">
                    {a.name.slice(0, 2).toUpperCase()}
                  </span>
                  {a.name}
                </span>
                <Button variant={on ? 'secondary' : 'primary'} size="sm" loading={saving} onClick={() => onAssign(on ? undefined : a.id)}>
                  {on ? <><Check size={14} /> Assigned</> : <><Plus size={14} /> Assign</>}
                </Button>
              </div>
            );
          })}
          {list.length === 0 && <div className="px-3 py-6 text-center text-xs text-muted">No agents match.</div>}
        </div>
      </div>
    </Modal>
  );
}

// ── Import wizard (3 steps) ───────────────────────────────────────────────────
const SAMPLE_CSV = 'name,phone,email,platform_id,lead_stage,lead_status\nRahul Sharma,919876543210,rahul@example.com,,new,active\nPriya Nair,919812345678,,FB-10021,contacted,active\n';

const pick = (headers: string[], names: string[]) => headers.findIndex((h) => names.includes(h));

export function ImportCustomersWizard({ orgId, onClose, onDone }: {
  orgId: string; onClose: () => void; onDone: (r: BulkImportResult) => void;
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [form, setForm] = useState('default');
  const [file, setFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<{ rows: Partial<CustomerInput>[]; total: number; missing: string[] } | null>(null);
  const [drag, setDrag] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<BulkImportResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const downloadSample = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([SAMPLE_CSV], { type: 'text/csv' }));
    a.download = 'customers-sample.csv'; a.click(); URL.revokeObjectURL(a.href);
  };

  const readFile = async (f: File) => {
    if (!/\.csv$/i.test(f.name)) { toast.error('Only .csv files are accepted.'); return; }
    const { headers, rows } = parseCsv(await f.text());
    const iName = pick(headers, ['name', 'full name', 'full_name', 'customer name', 'customer_name']);
    const iPhone = pick(headers, ['phone', 'mobile', 'phone number', 'phone_number', 'mobile number', 'number']);
    const iEmail = pick(headers, ['email', 'email address', 'email_address', 'e-mail']);
    const iPlat = pick(headers, ['platform id', 'platform_id', 'platformid']);
    const iStage = pick(headers, ['lead stage', 'lead_stage', 'stage']);
    const iStatus = pick(headers, ['lead status', 'lead_status', 'status']);
    const missing: string[] = [];
    if (iName < 0) missing.push('name');
    if (iPhone < 0 && iEmail < 0) missing.push('phone or email');
    const stageOk = (v: string): LeadStage | undefined => (LEAD_STAGES as string[]).includes(v) ? (v as LeadStage) : undefined;
    const statusOk = (v: string): LeadStatus | undefined => (LEAD_STATUSES as string[]).includes(v) ? (v as LeadStatus) : undefined;
    const mapped = rows.map((r) => ({
      name: iName >= 0 ? r[iName] : '',
      phone: iPhone >= 0 ? r[iPhone] || undefined : undefined,
      email: iEmail >= 0 ? r[iEmail] || undefined : undefined,
      platformId: iPlat >= 0 ? r[iPlat] || undefined : undefined,
      leadStage: iStage >= 0 ? stageOk(r[iStage].toLowerCase()) : undefined,
      leadStatus: iStatus >= 0 ? statusOk(r[iStatus].toLowerCase()) : undefined,
    }));
    setFile(f);
    setParsed({ rows: mapped, total: rows.length, missing });
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault(); setDrag(false);
    const f = e.dataTransfer.files?.[0]; if (f) void readFile(f);
  };
  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; e.target.value = ''; if (f) void readFile(f);
  };

  const run = async () => {
    if (!parsed) return;
    setStep(3); setRunning(true);
    try {
      const r = await customersService.bulkImport(orgId, parsed.rows, 'CSV Import');
      setResult(r); onDone(r);
    } catch (e) {
      toast.error((e as Error)?.message ?? 'Import failed');
      setStep(2);
    } finally { setRunning(false); }
  };

  const canNext = step === 1 ? true : step === 2 ? !!parsed && parsed.missing.length === 0 && parsed.total > 0 : false;

  return (
    <Modal open onClose={onClose} size="md" title={`Import Customers (${step}/3)`}
      footer={<>
        {step === 1 && <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>}
        {step === 2 && <Button variant="secondary" size="sm" onClick={() => setStep(1)}><ArrowLeft size={14} /> Back</Button>}
        {step < 3 && (
          <Button size="sm" disabled={!canNext} onClick={() => (step === 1 ? setStep(2) : run())}>
            {step === 2 ? 'Import' : 'Next'} <ArrowRight size={14} />
          </Button>
        )}
        {step === 3 && !running && <Button size="sm" onClick={onClose}>Done</Button>}
      </>}>
      {step === 1 && (
        <div className="space-y-3">
          <div>
            <div className="text-sm font-medium text-ink">Select Destination Form</div>
            <p className="text-xs text-muted">Choose which form to associate these imported customers with. The form determines which custom fields are available.</p>
          </div>
          <Select value={form} onChange={(e) => setForm(e.target.value)}>
            <option value="default">Default (Default)</option>
          </Select>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <div>
            <div className="text-sm font-medium text-ink">Download Sample File</div>
            <p className="mb-2 text-xs text-muted">Download our sample file to ensure your data is formatted correctly.</p>
            <Button variant="secondary" size="sm" onClick={downloadSample}><Download size={14} /> Download Sample .csv</Button>
          </div>
          <div>
            <div className="mb-1.5 text-sm font-medium text-ink">Upload Your File</div>
            <div
              onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}
              onClick={() => inputRef.current?.click()}
              className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded-[10px] border-2 border-dashed px-4 py-7 text-center transition-colors ${drag ? 'border-accent bg-accent-soft' : 'border-line hover:border-accent'}`}>
              <Upload size={20} className="text-muted" />
              {file ? (
                <>
                  <span className="text-sm font-medium text-ink">{file.name}</span>
                  <span className="text-xs text-muted">{parsed?.total ?? 0} row{parsed?.total === 1 ? '' : 's'} found · click to change</span>
                </>
              ) : (
                <>
                  <span className="text-sm text-ink">Click to upload or drag and drop</span>
                  <span className="text-xs text-muted">.csv only</span>
                </>
              )}
              <input ref={inputRef} type="file" accept=".csv,text/csv" hidden onChange={onPick} />
            </div>
          </div>
          {parsed && parsed.missing.length > 0 && (
            <div className="flex gap-2 rounded-[10px] border border-red/40 bg-red/5 p-2.5 text-xs text-red">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>The file is missing a column for: {parsed.missing.join(', ')}. Compare it with the sample.</span>
            </div>
          )}
        </div>
      )}

      {step === 3 && (
        running || !result ? <LoadingState label={`Importing ${parsed?.total ?? 0} customers…`} /> : (
          <div className="space-y-3">
            <div className="flex items-center gap-2 rounded-[10px] border border-green-2/40 bg-green-3 p-3 text-sm text-green-2">
              <CheckCircle2 size={16} className="shrink-0" />
              <span>Imported <b>{result.created}</b> customer{result.created === 1 ? '' : 's'}{result.skipped ? <> · <b>{result.skipped}</b> skipped</> : null}.</span>
            </div>
            {result.errors.length > 0 && (
              <div className="max-h-40 overflow-y-auto rounded-[10px] border border-line">
                <table className="w-full text-xs">
                  <thead className="bg-surface-2 text-muted"><tr><th className="px-3 py-1.5 text-left">Row</th><th className="px-3 py-1.5 text-left">Reason</th></tr></thead>
                  <tbody>{result.errors.map((e) => (
                    <tr key={e.row} className="border-t border-line"><td className="px-3 py-1.5 text-ink">{e.row}</td><td className="px-3 py-1.5 text-muted">{e.reason}</td></tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </div>
        )
      )}
    </Modal>
  );
}

// ── Google Sheets sync (4 steps, honest about not being connected) ────────────
const SHEET_STEPS = ['Account', 'Action', 'Destination', 'Status'];

export function GoogleSheetsSyncModal({ onClose, onGoToSettings }: { onClose: () => void; onGoToSettings: () => void }) {
  const step = 0; // No Google account can be connected yet, so the wizard cannot advance.
  return (
    <Modal open onClose={onClose} size="md"
      title="Google Sheets Sync"
      footer={<>
        <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
        <Button size="sm" disabled>Next <ArrowRight size={14} /></Button>
      </>}>
      <div className="space-y-4">
        <ol className="flex items-center gap-2 text-xs">
          {SHEET_STEPS.map((s, i) => (
            <li key={s} className="flex items-center gap-2">
              <span className={`grid h-5 w-5 place-items-center rounded-full text-[10px] font-semibold ${i === step ? 'bg-orange text-white' : 'bg-surface-2 text-muted'}`}>{i + 1}</span>
              <span className={i === step ? 'text-ink' : 'text-muted'}>{s}</span>
              {i < SHEET_STEPS.length - 1 && <span className="h-px w-6 bg-line" />}
            </li>
          ))}
        </ol>
        <div>
          <div className="text-sm font-medium text-ink">Select Google Sheets Account</div>
          <p className="text-xs text-muted">Choose the connected Google account.</p>
        </div>
        <div className="flex flex-col items-center gap-2 rounded-[10px] border border-orange/40 bg-orange/5 p-5 text-center">
          <AlertTriangle size={18} className="text-orange" />
          <p className="text-xs text-ink">No Google Sheets accounts connected. Connect one in Settings first.</p>
          <Button variant="secondary" size="sm" onClick={onGoToSettings}>Open Settings → Integrations</Button>
        </div>
      </div>
    </Modal>
  );
}
