import { Modal } from './Modal';
import { Button } from './Button';

export function ConfirmDialog({ open, title, message, confirmLabel = 'Confirm', danger, loading, onConfirm, onClose }: {
  open: boolean; title: string; message: string; confirmLabel?: string; danger?: boolean; loading?: boolean;
  onConfirm: () => void; onClose: () => void;
}) {
  return (
    <Modal open={open} onClose={onClose} title={title} size="sm"
      footer={<>
        <Button variant="secondary" size="sm" onClick={onClose} disabled={loading}>Cancel</Button>
        <Button variant={danger ? 'danger' : 'primary'} size="sm" loading={loading} onClick={onConfirm}>{confirmLabel}</Button>
      </>}>
      <p className="text-sm text-muted">{message}</p>
    </Modal>
  );
}
