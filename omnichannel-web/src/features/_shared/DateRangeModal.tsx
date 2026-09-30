import { useMemo, useState } from 'react';
import { Check } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';

/** Shared by Analytics and SEO so every dashboard picks dates the same way. */
export const DATE_PRESETS = [
  { key: '7', label: 'Last 7 days' },
  { key: '30', label: 'Last 30 days' },
  { key: '90', label: 'Last 90 days' },
];

export const isoDay = (d: Date) => d.toISOString().slice(0, 10);
export const prettyDay = (s: string) => new Date(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/**
 * Preset / custom range state. `endOffsetDays` shifts the window back for
 * sources that publish late (Search Console lags ~3 days).
 */
export function useDateRange(defaultPreset = '30', endOffsetDays = 0) {
  const [preset, setPreset] = useState(defaultPreset);
  const [customFrom, setCustomFrom] = useState(isoDay(new Date(Date.now() - 30 * 864e5)));
  const [customTo, setCustomTo] = useState(isoDay(new Date()));
  const [pickerOpen, setPickerOpen] = useState(false);

  const range = useMemo(() => {
    if (preset === 'custom') return { from: customFrom, to: customTo };
    const days = Number(preset);
    const end = Date.now() - endOffsetDays * 864e5;
    return { from: isoDay(new Date(end - (days - 1) * 864e5)), to: isoDay(new Date(end)) };
  }, [preset, customFrom, customTo, endOffsetDays]);

  const label = preset === 'custom'
    ? `${prettyDay(range.from)} – ${prettyDay(range.to)}`
    : `${DATE_PRESETS.find((p) => p.key === preset)?.label}: ${prettyDay(range.from)} – ${prettyDay(range.to)}`;

  const apply = (p: string, f: string, t: string) => { setPreset(p); setCustomFrom(f); setCustomTo(t); setPickerOpen(false); };
  return { preset, customFrom, customTo, range, label, pickerOpen, setPickerOpen, apply };
}

export function DateRangeModal({ preset, from, to, onApply, onClose }: {
  preset: string; from: string; to: string;
  onApply: (preset: string, from: string, to: string) => void;
  onClose: () => void;
}) {
  const [sel, setSel] = useState(preset);
  const [f, setF] = useState(from);
  const [t, setT] = useState(to);
  const invalid = sel === 'custom' && (!f || !t || new Date(f) > new Date(t));

  return (
    <Modal open onClose={onClose} title="Select date range" size="sm"
      footer={<>
        <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
        <Button size="sm" disabled={invalid} onClick={() => onApply(sel, f, t)}>Apply</Button>
      </>}>
      <div className="space-y-3">
        <div className="divide-y divide-line rounded-[10px] border border-line">
          {[...DATE_PRESETS, { key: 'custom', label: 'Custom range' }].map((p) => (
            <button key={p.key} type="button" onClick={() => setSel(p.key)}
              className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-sm hover:bg-surface-2">
              <span className={sel === p.key ? 'font-medium text-ink' : 'text-muted'}>{p.label}</span>
              {sel === p.key && <Check size={15} className="text-accent" />}
            </button>
          ))}
        </div>

        {sel === 'custom' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="From"><Input type="date" value={f} max={t} onChange={(e) => setF(e.target.value)} /></Field>
            <Field label="To" error={invalid ? 'End date must be after the start date.' : undefined}>
              <Input type="date" value={t} min={f} onChange={(e) => setT(e.target.value)} />
            </Field>
          </div>
        )}
      </div>
    </Modal>
  );
}
