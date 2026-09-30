import type { TemplateValidationResult, TemplateViolation } from '@/types';

/**
 * Client-side WhatsApp template policy check — advisory only.
 * Backend + Meta remain authoritative. Ported from the prototype's validator.
 */
export function validateWhatsAppTemplate(input: { category: string; body: string; header?: string; footer?: string; buttonCount?: number }): TemplateValidationResult {
  const v: TemplateViolation[] = [];
  const body = input.body ?? '';
  const varCount = (body.match(/\{\{\s*\d+\s*\}\}/g) ?? []).length;

  if (body.trim().length < 10) v.push({ code: 'BODY_TOO_SHORT', severity: 'FAIL', message: 'Body is too short to be approved.' });
  if (/(password|otp|cvv|card number|aadhaar|pan)/i.test(body)) v.push({ code: 'SENSITIVE_DATA', severity: 'FAIL', message: 'Requests sensitive data (OTP/card/ID) — prohibited.' });
  if (/(guaranteed|100% free|act now|urgent!!!)/i.test(body)) v.push({ code: 'PROHIBITED_LANGUAGE', severity: 'WARN', message: 'Contains coercive/marketing phrasing that may be rejected.' });
  if ((body.match(/!/g) ?? []).length > 3) v.push({ code: 'EXCESS_PUNCTUATION', severity: 'WARN', message: 'Too many exclamation marks.' });
  if (body === body.toUpperCase() && body.length > 12) v.push({ code: 'ALL_CAPS', severity: 'WARN', message: 'Avoid all-caps body text.' });
  if (input.category.toLowerCase() === 'marketing' && !/(stop|opt.?out|unsubscribe)/i.test(body + (input.footer ?? '')))
    v.push({ code: 'MISSING_OPT_OUT', severity: 'WARN', message: 'Marketing templates should include opt-out wording.' });
  if (varCount > 10) v.push({ code: 'TOO_MANY_VARS', severity: 'FAIL', message: 'More than 10 variables is not allowed.' });
  if ((input.buttonCount ?? 0) > 10) v.push({ code: 'TOO_MANY_BUTTONS', severity: 'FAIL', message: 'More than 10 buttons is not allowed.' });

  const verdict = v.some((x) => x.severity === 'FAIL') ? 'FAIL' : v.length ? 'WARN' : 'PASS';
  return { verdict, violations: v };
}
