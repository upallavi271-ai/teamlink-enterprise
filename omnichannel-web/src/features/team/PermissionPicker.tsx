import { useMemo } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Checkbox } from '@/components/ui/Checkbox';
import type { PermissionDef } from '@/types';

/**
 * The grouped permission catalogue, lifted verbatim out of RolesPage's role
 * editor so the policy editor uses the SAME interaction rather than a second
 * one that drifts. `GET team/permissions` is the only source of the list; this
 * component never invents a key.
 *
 * `inheritedBy` is the one thing the role editor needs and the policy editor
 * does not: a map of permission key -> names of the attached policies that
 * already grant it. Those rows are annotated, never auto-checked — the checkbox
 * keeps meaning "granted DIRECTLY on this role", so a person can see at a glance
 * which permissions would survive detaching every policy.
 */
export function PermissionPicker({ perms, selected, inheritedBy, readOnly, onToggle, onToggleGroup }: {
  perms: PermissionDef[];
  selected: Set<string>;
  inheritedBy?: Map<string, string[]>;
  readOnly?: boolean;
  onToggle: (key: string) => void;
  onToggleGroup: (list: PermissionDef[], on: boolean) => void;
}) {
  const groups = useMemo(() => {
    const by = new Map<string, PermissionDef[]>();
    for (const p of perms) {
      if (!by.has(p.group)) by.set(p.group, []);
      by.get(p.group)!.push(p);
    }
    return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [perms]);

  if (perms.length === 0) {
    return <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">No permission catalogue was returned by the server.</p>;
  }

  return (
    <div className="space-y-4">
      {groups.map(([group, list]) => {
        const all = list.every((p) => selected.has(p.key));
        return (
          <div key={group}>
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted">{group}</span>
              {!readOnly && (
                <button type="button" onClick={() => onToggleGroup(list, !all)}
                  className="text-xs text-accent hover:underline">
                  {all ? 'Clear all' : 'Select all'}
                </button>
              )}
            </div>
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {list.map((p) => {
                const via = inheritedBy?.get(p.key);
                return (
                  <label key={p.key}
                    className={`flex items-start gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-surface-2 ${via ? 'bg-accent-soft' : ''}`}>
                    <Checkbox className="mt-0.5" checked={selected.has(p.key)} disabled={readOnly}
                      onChange={() => onToggle(p.key)} />
                    <span className="min-w-0">
                      <span className="text-ink">{p.description}</span>
                      {via && (
                        <Badge tone="green" className="ml-1.5 align-middle"
                          title={`Already granted by: ${via.join(', ')}`}>
                          via {via.length === 1 ? via[0] : `${via.length} policies`}
                        </Badge>
                      )}
                      <span className="block font-mono text-[11px] text-muted">{p.key}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
