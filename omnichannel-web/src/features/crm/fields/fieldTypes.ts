import type { CustomFieldType } from '@/types';

/** Label and hint for every data type, in the order the picker shows them. */
export const FIELD_TYPES: { value: CustomFieldType; label: string; hint: string }[] = [
  { value: 'text', label: 'Text', hint: 'Any short free text' },
  { value: 'number', label: 'Number', hint: 'Digits only' },
  { value: 'boolean', label: 'True/False (Checkbox)', hint: 'A single yes/no' },
  { value: 'date', label: 'Date (YYYY-MM-DD)', hint: 'A calendar date' },
  { value: 'time', label: 'Time (HH:MM)', hint: 'A time of day' },
  { value: 'url', label: 'Website URL', hint: 'A link' },
  { value: 'dropdown', label: 'Dropdown (Single Selection)', hint: 'Pick one from a list' },
  { value: 'multiselect', label: 'Checkboxes (Multiple Selection)', hint: 'Pick several from a list' },
];

export const typeLabel = (t: CustomFieldType): string =>
  FIELD_TYPES.find((f) => f.value === t)?.label ?? t;

/** Only these two carry an options list. */
export const isChoiceType = (t: CustomFieldType): boolean => t === 'dropdown' || t === 'multiselect';

/**
 * Swatches for the field colour picker. Every entry is a Tailwind palette step
 * at 500/600 weight, so they all sit in a readable lightness band on white.
 */
export const FIELD_COLORS: string[] = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e',
  '#10b981', '#14b8a6', '#06b6d4', '#0ea5e9', '#3b82f6', '#6366f1',
  '#8b5cf6', '#a855f7', '#d946ef', '#ec4899', '#f43f5e', '#64748b',
  '#dc2626', '#ea580c', '#d97706', '#ca8a04', '#65a30d', '#16a34a',
  '#059669', '#0d9488', '#0891b2', '#0284c7', '#2563eb', '#4f46e5',
  '#7c3aed', '#9333ea', '#c026d3', '#db2777', '#e11d48', '#475569',
];

/** A stable key from a label: "Monthly Budget" → "monthly_budget". */
export const slugKey = (s: string): string =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
