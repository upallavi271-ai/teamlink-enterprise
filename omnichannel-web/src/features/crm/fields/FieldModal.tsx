import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Check, X, AlertTriangle, Plus } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { Checkbox } from '@/components/ui/Checkbox';
import { FIELD_TYPES, FIELD_COLORS, isChoiceType, slugKey } from './fieldTypes';
import type { CustomField, CustomFieldInput, CustomFieldType } from '@/types';

/**
 * Create / edit a custom field. One component for both so the two stay in step —
 * the only differences are the title, the button label, and that editing warns
 * before a type change that could strand existing data.
 */
export function FieldModal({ field, existingKeys, saving, onSave, onClose }: {
  /** null = create */
  field: CustomField | null;
  /** keys already taken, so a duplicate is caught before the server rejects it */
  existingKeys: string[];
  saving: boolean;
  onSave: (input: CustomFieldInput) => void;
  onClose: () => void;
}) {
  const editing = !!field;
  const [name, setName] = useState(field?.name ?? '');
  const [key, setKey] = useState(field?.key ?? '');
  const [keyTouched, setKeyTouched] = useState(!!field);
  const [type, setType] = useState<CustomFieldType>(field?.type ?? 'text');
  const [color, setColor] = useState(field?.color ?? '#11985a');
  const [required, setRequired] = useState(field?.required ?? false);
  const [options, setOptions] = useState<string[]>(field?.options ?? []);
  const [draft, setDraft] = useState('');
  const [swatchOpen, setSwatchOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const optionInput = useRef<HTMLInputElement>(null);

  // The key follows the label until the user edits it themselves.
  useEffect(() => { if (!keyTouched) setKey(slugKey(name)); }, [name, keyTouched]);

  const choice = isChoiceType(type);
  const typeChanged = editing && field!.type !== type;
  const takenKeys = useMemo(
    () => existingKeys.filter((k) => k !== field?.key),
    [existingKeys, field],
  );

  const addOption = () => {
    const v = draft.trim();
    if (!v) return;
    if (options.some((o) => o.toLowerCase() === v.toLowerCase())) { setErr(`"${v}" is already an option.`); return; }
    setOptions((o) => [...o, v]);
    setDraft('');
    setErr(null);
    optionInput.current?.focus();
  };
  const onOptionKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); addOption(); }
    // Backspace on an empty box removes the last chip — standard tag-input behaviour.
    if (e.key === 'Backspace' && !draft && options.length) setOptions((o) => o.slice(0, -1));
  };

  const submit = () => {
    if (!name.trim()) { setErr('Display label is required.'); return; }
    const k = (key || slugKey(name)).trim();
    if (!k) { setErr('Field key is required.'); return; }
    if (!/^[a-z][a-z0-9_]*$/.test(k)) { setErr('Field key must start with a letter and use lowercase letters, numbers or underscores.'); return; }
    if (takenKeys.includes(k)) { setErr(`The key "${k}" is already used by another field.`); return; }
    if (choice && options.length === 0) { setErr('Add at least one option for a choice field.'); return; }
    setErr(null);
    onSave({ name: name.trim(), key: k, type, color, required, options: choice ? options : [] });
  };

  return (
    <Modal open onClose={onClose} size="sm"
      title={editing ? 'Edit Field' : 'Create New Field'}
      footer={<>
        <Button variant="secondary" size="sm" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button size="sm" loading={saving} onClick={submit}>{editing ? 'Update Field' : 'Create Field'}</Button>
      </>}>
      <div className="space-y-3.5">
        <Field label="Display Label">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Monthly Budget" autoFocus />
        </Field>

        <Field label="Field Key" hint="Used in bot flows and imports. Generated from the label until you change it.">
          <Input value={key} onChange={(e) => { setKeyTouched(true); setKey(e.target.value); }}
            className="font-mono text-xs" placeholder="monthly_budget" />
        </Field>

        {/* ── Field colour ── */}
        <div>
          <span className="mb-1.5 block text-sm font-medium text-ink">Field Color</span>
          <div className="relative">
            <button type="button" onClick={() => setSwatchOpen((o) => !o)}
              className="flex w-full items-center gap-2.5 rounded-[10px] border border-line bg-surface p-2 text-left hover:bg-surface-2">
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-white" style={{ background: color }}>
                <Check size={14} />
              </span>
              <span className="leading-tight">
                <span className="block font-mono text-xs text-ink">{color.toUpperCase()}</span>
                <span className="block text-[11px] text-muted">Selected from Tailwind palette</span>
              </span>
            </button>

            {swatchOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setSwatchOpen(false)} />
                <div className="absolute left-0 z-20 mt-1 w-full rounded-[10px] border border-line bg-surface p-2.5 shadow-card">
                  <div className="grid grid-cols-9 gap-1.5">
                    {FIELD_COLORS.map((c) => (
                      <button key={c} type="button" title={c.toUpperCase()} aria-label={`Colour ${c}`}
                        onClick={() => { setColor(c); setSwatchOpen(false); }}
                        className="grid h-6 w-6 place-items-center rounded-full ring-offset-1 transition-transform hover:scale-110"
                        style={{ background: c, boxShadow: color === c ? '0 0 0 2px var(--surface), 0 0 0 4px var(--ink)' : undefined }}>
                        {color === c && <Check size={12} className="text-white" />}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        {/* ── Data type ── */}
        <Field label="Data Type">
          <Select value={type} onChange={(e) => setType(e.target.value as CustomFieldType)}>
            {FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </Select>
        </Field>

        {typeChanged && (
          <p className="flex items-start gap-1.5 text-xs text-orange">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            Changing the type may affect data already stored in this field.
          </p>
        )}

        {/* ── Options, for choice types only ── */}
        {choice && (
          <div className="rounded-[10px] border border-line bg-surface-2 p-3">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
              {type === 'dropdown' ? 'Dropdown options' : 'Checkbox options'}
            </div>

            {options.length > 0 && (
              <div className="mb-2 flex max-h-28 flex-wrap gap-1.5 overflow-y-auto">
                {options.map((o, i) => (
                  <span key={o} className="inline-flex items-center gap-1 rounded-full border border-line bg-surface px-2 py-0.5 text-xs text-ink">
                    {o}
                    <button type="button" aria-label={`Remove ${o}`} className="text-muted hover:text-red"
                      onClick={() => setOptions((prev) => prev.filter((_, idx) => idx !== i))}>
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )}

            <div className="flex gap-2">
              <Input ref={optionInput} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onOptionKey}
                placeholder="Type option & press Enter" className="h-9" />
              <Button variant="secondary" size="sm" onClick={addOption} disabled={!draft.trim()}>
                <Plus size={14} /> Add
              </Button>
            </div>
            {options.length === 0 && <p className="mt-1.5 text-[11px] text-muted">At least one option is required.</p>}
          </div>
        )}

        <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
          <Checkbox checked={required} onChange={() => setRequired((r) => !r)} />
          Required field
        </label>

        {err && (
          <div className="flex gap-2 rounded-[10px] border border-red/40 bg-red/5 p-2.5 text-xs text-red">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>{err}</span>
          </div>
        )}
      </div>
    </Modal>
  );
}
