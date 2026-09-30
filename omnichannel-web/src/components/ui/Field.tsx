import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function Field({ label, error, hint, children }: { label?: string; error?: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      {label && <span className="text-sm font-medium text-ink">{label}</span>}
      {children}
      {error ? <span className="block text-xs text-red">{error}</span> : hint ? <span className="block text-xs text-muted">{hint}</span> : null}
    </label>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(
  function Input({ className, invalid, ...rest }, ref) {
    return (
      <input
        ref={ref}
        className={cn(
          'h-10 w-full rounded-[10px] border bg-surface px-3 text-sm text-ink placeholder:text-muted',
          'focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent',
          invalid ? 'border-red' : 'border-line', className,
        )}
        {...rest}
      />
    );
  },
);
