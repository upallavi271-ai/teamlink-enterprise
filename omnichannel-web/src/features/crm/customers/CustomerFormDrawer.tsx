import { useEffect, useState } from 'react';
import { Drawer } from '@/components/ui/Drawer';
import { Field, Input } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { LEAD_STAGES, LEAD_STATUSES, SOURCES, cap } from '../crmLabels';
import type { Customer, CustomerInput, Agent } from '@/types';

const empty: CustomerInput = { name: '', phone: '', email: '', source: 'WhatsApp', leadStage: 'new', leadStatus: 'active', platformId: '', assignedAgentId: undefined };

export function CustomerFormDrawer({ open, onClose, editing, agents, onSubmit, saving }: {
  open: boolean; onClose: () => void; editing: Customer | null; agents: Agent[];
  onSubmit: (input: CustomerInput) => void; saving: boolean;
}) {
  const [form, setForm] = useState<CustomerInput>(empty);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (open) {
      setErrors({});
      setForm(editing
        ? { name: editing.name, phone: editing.phone ?? '', email: editing.email ?? '', source: editing.source, campaignName: editing.campaignName, leadStage: editing.leadStage, leadStatus: editing.leadStatus, platformId: editing.platformId ?? '', assignedAgentId: editing.assignedAgentId }
        : empty);
    }
  }, [open, editing]);

  const set = (k: keyof CustomerInput, v: string) => setForm((f) => ({ ...f, [k]: v || undefined }));

  const validate = () => {
    const e: Record<string, string> = {};
    if (!form.name.trim()) e.name = 'Name is required.';
    if (form.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email)) e.email = 'Enter a valid email.';
    if (form.phone && !/^\+?[0-9\s-]{7,15}$/.test(form.phone)) e.phone = 'Enter a valid phone.';
    if (!form.phone && !form.email) e.phone = 'Provide a phone or an email.';
    setErrors(e);
    return Object.keys(e).length === 0;
  };
  const submit = (e: React.FormEvent) => { e.preventDefault(); if (validate()) onSubmit({ ...form, name: form.name.trim() }); };

  return (
    <Drawer open={open} onClose={onClose} title={editing ? 'Edit customer' : 'Add customer'}
      footer={<>
        <Button variant="secondary" size="sm" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button size="sm" loading={saving} onClick={submit}>{editing ? 'Save changes' : 'Add customer'}</Button>
      </>}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Full name" error={errors.name}><Input value={form.name} invalid={!!errors.name} onChange={(e) => set('name', e.target.value)} /></Field>
        <Field label="Phone" error={errors.phone}><Input value={form.phone ?? ''} invalid={!!errors.phone} onChange={(e) => set('phone', e.target.value)} placeholder="+9198…" /></Field>
        <Field label="Email" error={errors.email}><Input value={form.email ?? ''} invalid={!!errors.email} onChange={(e) => set('email', e.target.value)} /></Field>
        <Field label="Source"><Select value={form.source} onChange={(e) => set('source', e.target.value)}>{SOURCES.map((s) => <option key={s}>{s}</option>)}</Select></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Lead stage"><Select value={form.leadStage} onChange={(e) => set('leadStage', e.target.value)}>{LEAD_STAGES.map((s) => <option key={s} value={s}>{cap(s)}</option>)}</Select></Field>
          <Field label="Lead status"><Select value={form.leadStatus} onChange={(e) => set('leadStatus', e.target.value)}>{LEAD_STATUSES.map((s) => <option key={s} value={s}>{cap(s)}</option>)}</Select></Field>
        </div>
        <Field label="Assigned agent">
          <Select value={form.assignedAgentId ?? ''} onChange={(e) => set('assignedAgentId', e.target.value)}>
            <option value="">Unassigned</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
        </Field>
      </form>
    </Drawer>
  );
}
