import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

type Tone = 'neutral' | 'green' | 'blue' | 'orange' | 'red' | 'violet';
const tones: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-muted border-line',
  green: 'bg-green-3 text-green-2 border-green-3',
  blue: 'bg-blue/10 text-blue border-blue/20',
  orange: 'bg-orange/10 text-orange border-orange/20',
  red: 'bg-red/10 text-red border-red/20',
  violet: 'bg-violet/10 text-violet border-violet/20',
};

export function Badge({ tone = 'neutral', className, ...rest }: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span
      className={cn('inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium', tones[tone], className)}
      {...rest}
    />
  );
}
