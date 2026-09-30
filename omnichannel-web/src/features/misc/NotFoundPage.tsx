import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';

export function NotFoundPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-bg p-6 text-center">
      <div className="font-display text-5xl font-bold text-accent">404</div>
      <p className="text-muted">This page could not be found.</p>
      <Link to="/app/dashboard"><Button>Back to dashboard</Button></Link>
    </div>
  );
}
