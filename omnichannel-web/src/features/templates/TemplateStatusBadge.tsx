import {
  BadgeCheck, Ban, CircleDashed, CircleHelp, CirclePause, CircleX, Clock, CloudOff, type LucideIcon,
} from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import type { Template } from '@/types';
import { templateStatusView, type StatusGlyph } from './templateStatus';

const GLYPHS: Record<Exclude<StatusGlyph, 'none'>, LucideIcon> = {
  'not-submitted': CircleDashed,
  review: Clock,
  approved: BadgeCheck,
  rejected: CircleX,
  paused: CirclePause,
  blocked: Ban,
  missing: CloudOff,
  unknown: CircleHelp,
};

/**
 * A template's status, stated as what is actually true — see templateStatus.ts
 * for the mapping. For WhatsApp that is Meta's verdict or "Not submitted", with
 * any contradicting local label shown beside it; other channels keep the plain
 * local status badge.
 */
export function TemplateStatusBadge({ template }: { template: Template }) {
  const v = templateStatusView(template);
  const Icon: LucideIcon | null = v.glyph === 'none' ? null : GLYPHS[v.glyph];
  return (
    <span className="inline-flex max-w-[260px] flex-wrap items-center gap-x-1.5 gap-y-0.5" title={v.title}>
      <Badge tone={v.tone} className="whitespace-nowrap">
        {Icon && <Icon size={12} aria-hidden />}
        {v.label}
      </Badge>
      {v.secondary && (
        <span className={`min-w-0 truncate text-xs ${v.secondaryWarn ? 'font-medium text-orange' : 'text-muted'}`}>
          · {v.secondary}
        </span>
      )}
    </span>
  );
}
