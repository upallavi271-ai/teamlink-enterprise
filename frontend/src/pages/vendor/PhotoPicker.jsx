import { useState } from 'react';
import { shrinkAll } from './shrinkPhoto.js';

// THREE CLEAR WAYS TO ADD A BILL (founder 2026-10-28: "photos ayina upload chesey laga undali, ikkada only files upload ani vastundi").
// One mixed "PDF or photo" picker opens only the Files app on many phones, so photos looked impossible. Now:
//   Take a photo      the camera opens straight away
//   Choose photos     the phone's gallery (several at once when `multiple`)
//   Choose PDF        a PDF from the phone / computer
// Every photo is made small (a JPG of at most 2200 px) before it is handed to onPick; HEIC is converted when the browser can open it.
// onPick(files: File[], problems: string[])
export default function PhotoPicker({ onPick, multiple = false, disabled = false, pdf = true, small = false }) {
  const [busy, setBusy] = useState(false);
  const take = async (list) => {
    const files = Array.from(list || []);
    if (!files.length) return;
    setBusy(true);
    const s = await shrinkAll(files);
    setBusy(false);
    onPick(s.files, s.problems);
  };
  const cls = `btn${small ? ' btn-sm' : ''}`;
  const input = (accept, extra = {}) => (
    <input type="file" accept={accept} style={{ display: 'none' }} disabled={disabled || busy} {...extra}
      onChange={(e) => { const l = Array.from(e.target.files || []); e.target.value = ''; take(l); }} />
  );
  return (
    <span className="vm-row" style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
      <label className={`${cls} btn-primary`} style={{ cursor: 'pointer' }}>Take a photo{input('image/*', { capture: 'environment', 'aria-label': 'Take a photo' })}</label>
      <label className={cls} style={{ cursor: 'pointer' }}>Choose photos{input('image/*,.heic,.heif', { multiple, 'aria-label': 'Choose photos from the gallery' })}</label>
      {pdf && <label className={cls} style={{ cursor: 'pointer' }}>Choose PDF{input('application/pdf,.pdf', { multiple, 'aria-label': 'Choose a PDF' })}</label>}
      {busy && <span className="cell-muted" role="status">Getting the photo ready&hellip;</span>}
    </span>
  );
}
