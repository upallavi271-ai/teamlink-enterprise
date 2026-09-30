import { CheckCircle2, XCircle, Info, X } from 'lucide-react';
import { useToastStore, type ToastTone } from './toastStore';

const icon: Record<ToastTone, typeof Info> = { success: CheckCircle2, error: XCircle, info: Info };
const color: Record<ToastTone, string> = { success: 'text-green-2', error: 'text-red', info: 'text-blue' };

export function Toaster() {
  const { toasts, dismiss } = useToastStore();
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-full max-w-sm flex-col gap-2">
      {toasts.map((t) => {
        const Icon = icon[t.tone];
        return (
          <div key={t.id} className="pointer-events-auto flex items-start gap-3 rounded-card border border-line bg-surface p-3 shadow-card">
            <Icon size={18} className={color[t.tone]} />
            <p className="flex-1 text-sm text-ink">{t.message}</p>
            <button onClick={() => dismiss(t.id)} className="text-muted hover:text-ink" aria-label="Dismiss"><X size={15} /></button>
          </div>
        );
      })}
    </div>
  );
}
