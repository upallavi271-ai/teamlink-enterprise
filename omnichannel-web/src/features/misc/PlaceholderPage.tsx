import { Construction } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardBody } from '@/components/ui/Card';

/** Honest "planned" page — no fake data, no fake connected states. */
export function PlaceholderPage({ title }: { title: string }) {
  return (
    <div>
      <PageHeader title={title} subtitle="Planned module" />
      <Card>
        <CardBody className="flex flex-col items-center justify-center gap-3 py-16 text-center">
          <div className="rounded-full bg-surface-2 p-3 text-muted"><Construction size={22} /></div>
          <p className="font-medium text-ink">{title} is on the roadmap</p>
          <p className="max-w-md text-sm text-muted">
            The foundation, design system and navigation are in place. This module will be built on the
            established list/detail/form patterns and wired to the API when its backend endpoints land.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
