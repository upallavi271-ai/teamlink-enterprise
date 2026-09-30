/**
 * `POST /v1/templates/:id/submit`, with its confirmation and — the point of the
 * component — its failures.
 *
 * Submitting is not undoable from here and it is not free: the server runs the
 * WhatsApp policy check first precisely because a rejected submission counts
 * against the WhatsApp Business Account's template quality rating, and repeated
 * rejections throttle template creation for the whole account. So this is a
 * dialog with a confirm step, not a one-click row button.
 *
 * When the server refuses, its explanation is the whole value of the response
 * and it is shown verbatim. Two of the refusals carry that explanation in
 * `details` rather than `message`:
 *
 *   TEMPLATE_NOT_SUBMITTABLE  message: "This template cannot be submitted to
 *                             Meta as it stands."
 *                             details: ["An image header needs a sample file
 *                             uploaded to Meta before the template can be
 *                             submitted. …"]
 *   TEMPLATE_POLICY_FAILED    details: [{ code, severity, message }, …]
 *
 * A generic "submit failed" here would throw away the only sentence that tells
 * the user what to change. The dialog therefore stays OPEN on failure with every
 * line the server sent, instead of closing behind a toast.
 */
import { AlertTriangle, CheckCircle2, Send } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { apiErrorDetailLines, apiErrorMessage } from './metaErrorDetails';
import type { TemplateSubmitResult } from '@/services/templates/templates.types';
import type { Template } from '@/types';

export function SubmitToMetaDialog({ template, pending, error, result, onSubmit, onClose }: {
  template: Template | null;
  pending: boolean;
  error: Error | null;
  result?: TemplateSubmitResult;
  onSubmit: () => void;
  onClose: () => void;
}) {
  if (!template) return null;
  const detailLines = error ? apiErrorDetailLines(error) : [];
  const warnings = result?.policy.violations.filter((v) => v.severity === 'WARN') ?? [];

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={result ? 'Submitted to Meta' : 'Submit to Meta'}
      footer={result
        ? <Button size="sm" onClick={onClose}>Done</Button>
        : <>
            <Button variant="secondary" size="sm" onClick={onClose} disabled={pending}>Cancel</Button>
            <Button size="sm" onClick={onSubmit} loading={pending}>
              <Send size={14} /> {error ? 'Try again' : 'Submit to Meta'}
            </Button>
          </>}
    >
      <div className="space-y-4">
        <div className="rounded-card border border-line bg-surface-2 px-4 py-3">
          <p className="flex flex-wrap items-baseline gap-2">
            <span className="font-mono text-sm text-ink">{template.name}</span>
            <Badge>{template.language || 'en'}</Badge>
            <Badge>{template.category}</Badge>
          </p>
          <p className="mt-2 whitespace-pre-wrap text-sm text-muted">{template.body}</p>
        </div>

        {result ? (
          <>
            <div className="flex gap-2 rounded-card border border-green-3 bg-green-3 px-4 py-3">
              <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-green-2" />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-ink">
                  Meta accepted the template and returned{' '}
                  <span className="font-mono text-xs">{result.meta.status}</span>.
                </p>
                <p className="mt-1 text-sm text-muted">
                  Meta template id <span className="font-mono text-xs">{result.meta.templateId}</span>
                  {result.meta.category ? <> · category <span className="font-mono text-xs">{result.meta.category}</span></> : null}.
                  The local status is now <span className="text-ink">{result.template.status.replace('_', ' ')}</span> — Meta
                  reviews it from here, and a later sync picks up its verdict.
                </p>
              </div>
            </div>
            {warnings.length > 0 && (
              <div className="rounded-card border border-line bg-surface-2 px-4 py-3">
                <p className="text-xs font-medium uppercase tracking-wide text-muted">
                  Policy warnings — accepted anyway, but they can affect review
                </p>
                <ul className="mt-2 space-y-1">
                  {warnings.map((w) => <li key={w.code} className="text-sm text-ink">{w.message}</li>)}
                </ul>
              </div>
            )}
          </>
        ) : error ? (
          <div className="rounded-card border border-red/20 bg-red/10 px-4 py-3">
            <p className="flex items-center gap-2 text-sm font-semibold text-red">
              <AlertTriangle size={15} /> Not submitted. Nothing was sent to Meta.
            </p>
            {/* The server's own words, in full. */}
            <p className="mt-2 text-sm text-ink">{apiErrorMessage(error, 'The server refused this submission.')}</p>
            {detailLines.length > 0 && (
              <ul className="mt-2 space-y-1.5">
                {detailLines.map((line) => (
                  <li key={line} className="text-sm text-ink">{line}</li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted">
            Green Start will run the WhatsApp policy check and then register this template with Meta. Meta reviews it and
            normally returns <span className="font-mono text-xs">PENDING</span>; the status stored afterwards is Meta’s, not
            a local one. A rejected submission counts against this WhatsApp Business Account’s template quality rating, so
            it is worth reading the body once more before sending.
          </p>
        )}
      </div>
    </Modal>
  );
}
