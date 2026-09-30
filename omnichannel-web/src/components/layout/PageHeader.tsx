import type { ReactNode } from 'react';

/**
 * The page header every module opens with: title, optional subtitle, optional
 * actions on the right.
 *
 * Details that were corrected against the reference and now live here rather
 * than being re-decided per page:
 *
 * - Alignment depends on whether there is a subtitle. With a subtitle the left
 *   block is taller than the buttons, so their TOPS are aligned — otherwise
 *   `items-end` drags the title down and the first line of the page stops being
 *   the title. With no subtitle both sides are one line, and centring them looks
 *   right where aligning tops would leave the title sitting a few pixels high.
 * - The actions row wraps. Three buttons beside a long title is common
 *   (Customers has Import / Google Sheets / Add Customer); without wrapping they
 *   squeeze the title instead of moving to their own line.
 * - The h1 is a flex row, so a page can put an icon beside its title without
 *   abandoning this component and hand-rolling the markup — which is exactly how
 *   two versions of this header came to exist.
 */
export function PageHeader({ title, subtitle, actions }: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className={`mb-5 flex flex-wrap justify-between gap-3 ${subtitle ? 'items-start' : 'items-center'}`}>
      <div>
        <h1 className="flex items-center gap-2 font-display text-xl font-semibold text-ink">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
