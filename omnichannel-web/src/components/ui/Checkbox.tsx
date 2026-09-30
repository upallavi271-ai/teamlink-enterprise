import type { InputHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';
export function Checkbox({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input type="checkbox" className={cn('h-4 w-4 rounded border-line text-accent accent-[var(--accent)]', className)} {...rest} />;
}
