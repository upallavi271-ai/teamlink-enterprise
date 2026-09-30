import { RouterProvider } from 'react-router-dom';
import { AppProviders } from './providers';
import { router } from './router';
import { Toaster } from '@/components/toast/Toaster';

export function App() {
  return (
    <AppProviders>
      <RouterProvider router={router} />
      <Toaster />
    </AppProviders>
  );
}
