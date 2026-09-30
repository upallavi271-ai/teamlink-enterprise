import { forwardRef, type SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }>(
  function Select({ className, invalid, children, ...rest }, ref) {
    return (
      <select
        ref={ref}
        className={cn(
          'h-10 w-full rounded-[10px] border bg-surface px-3 text-sm text-ink',
          'focus-visible:outline-2 focus-visible:outline-accent',
          invalid ? 'border-red' : 'border-line', className,
        )}
        {...rest}
      >
        {children}
      </select>
    );
  },
);
