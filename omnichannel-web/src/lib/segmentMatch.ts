import type { Customer, Segment, SegmentRule } from '@/types';

function ruleMatches(c: Customer, r: SegmentRule): boolean {
  const val = String((c as unknown as Record<string, unknown>)[r.field] ?? '').toLowerCase();
  const target = r.value.toLowerCase();
  switch (r.operator) {
    case 'equals': return val === target;
    case 'not_equals': return val !== target;
    case 'contains': return val.includes(target);
    case 'in': return target.split(',').map((s) => s.trim().toLowerCase()).includes(val);
    default: return false;
  }
}

export function customerMatchesSegment(c: Customer, seg: Pick<Segment, 'rules' | 'logic'>): boolean {
  if (seg.rules.length === 0) return false;
  return seg.logic === 'AND' ? seg.rules.every((r) => ruleMatches(c, r)) : seg.rules.some((r) => ruleMatches(c, r));
}
