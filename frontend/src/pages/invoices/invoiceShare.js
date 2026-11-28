// Send an invoice from its View: Email, WhatsApp or the device's Share sheet. A web page cannot attach the file to an email or
// a chat by itself, so the message is written here and the person attaches the PDF saved with "Print / Save as PDF".
// After sending, the invoice can be marked as sent (PATCH /invoices/:id/sent), which the register and "Generate invoices" show.
import api from '../../api';
import { money2, fmtD } from './invFormat';

export function shareText(doc) {
  const co = doc.company || {};
  const bank = co.bank || {};
  const subject = `Invoice ${doc.invoiceNumber} - ${co.legalName || 'TeamLink Consultants'}`;
  const body = [
    `Dear ${doc.client?.name || 'Sir / Madam'},`,
    '',
    `Please find our invoice ${doc.invoiceNumber} dated ${fmtD(doc.invoiceDate)} for ${money2(doc.totals.invoiceValue)} (including GST).`,
    bank.accountNumber ? `Bank: ${bank.accountName || ''}, A/c ${bank.accountNumber}, IFSC ${bank.ifsc || ''}${bank.upi ? `, UPI ${bank.upi}` : ''}` : null,
    '',
    'Regards,',
    co.legalName || 'TeamLink Consultants',
  ].filter((x) => x !== null).join('\n');
  return { subject, body };
}

// win = the window the button was pressed in (this page, or the invoice's own tab).
export async function sendInvoice(win, how, doc, ids, onSent) {
  const { subject, body } = shareText(doc);
  if (how === 'Email') {
    win.open(`mailto:${encodeURIComponent(doc.client?.email || '')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`, '_blank');
  } else if (how === 'WhatsApp') {
    win.open(`https://wa.me/?text=${encodeURIComponent(body)}`, '_blank');
  } else {
    if (win.navigator.share) { try { await win.navigator.share({ title: subject, text: body }); } catch { return; } } else {
      try { await win.navigator.clipboard.writeText(`${subject}\n\n${body}`); win.alert('The message is copied. Paste it where you want to send it, and attach the saved PDF.'); } catch { win.prompt('Copy this message', `${subject} - ${body}`); }
    }
    return;
  }
  if (win.confirm(`Attach the PDF (Print / Save as PDF) to your ${how} message.\n\nMark this invoice as SENT by ${how}?`)) {
    try {
      await Promise.all((ids || []).map((id) => api.patch(`/invoices/${id}/sent`, { via: how })));
      if (onSent) onSent();
    } catch (e) { win.alert(e.response?.data?.error || 'It could not be marked as sent.'); }
  }
}
