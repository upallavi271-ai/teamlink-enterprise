import { forwardRef, type TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(
  function Textarea({ className, invalid, ...rest }, ref) {
    return (
      <textarea
        ref={ref}
        className={cn(
          'w-full rounded-[10px] border bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted',
          'focus-visible:outline-2 focus-visible:outline-accent',
          invalid ? 'border-red' : 'border-line', className,
        )}
        {...rest}
      />
    );
  },
);
