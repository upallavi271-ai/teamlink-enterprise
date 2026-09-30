/**
 * Pulls the extra lines an API failure carries in `error.details` out of a
 * thrown error, without losing any of them.
 *
 * This exists because the templates module's most useful refusals put their
 * explanation in `details`, not in `message`. Submitting a template with a media
 * header answers 422 with
 *
 *   message: "This template cannot be submitted to Meta as it stands."
 *   details: ["An image header needs a sample file uploaded to Meta before …"]
 *
 * so a UI that renders only `message` tells the user a submission failed and
 * throws away the one sentence that says what to do about it.
 *
 * `details` is typed `Array<{ field, message }>` on the client's ApiError, but
 * the server sends it as `unknown` and the templates endpoints actually send
 * plain strings (`TEMPLATE_NOT_SUBMITTABLE`) or policy violations
 * (`TEMPLATE_POLICY_FAILED`: `{ code, severity, message }`). So the value is
 * read defensively and anything that is not a list of lines yields nothing
 * rather than a stringified object.
 */

export function apiErrorDetailLines(err: unknown): string[] {
  const details = (err as { details?: unknown } | null | undefined)?.details;
  if (!Array.isArray(details)) return [];
  const lines: string[] = [];
  for (const entry of details) {
    if (typeof entry === 'string') {
      if (entry.trim()) lines.push(entry.trim());
      continue;
    }
    if (entry && typeof entry === 'object') {
      const o = entry as { message?: unknown; field?: unknown };
      if (typeof o.message === 'string' && o.message.trim()) {
        lines.push(typeof o.field === 'string' && o.field ? `${o.field}: ${o.message}` : o.message);
      }
    }
  }
  return lines;
}

/** The message to show for a thrown error, never empty. */
export function apiErrorMessage(err: unknown, fallback: string): string {
  const message = (err as { message?: unknown } | null | undefined)?.message;
  return typeof message === 'string' && message.trim() ? message : fallback;
}
