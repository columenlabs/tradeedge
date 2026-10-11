import { TooltipProvider } from '@/components/ui/tooltip';
import { ApiError } from '@/lib/api';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { router } from './router';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A 429 means over the per-person limit: retrying only spends more of it.
      retry: (failures, err) => failures < 1 && !(err instanceof ApiError && err.status === 429),
      refetchOnWindowFocus: false,
    },
  },
});

const el = document.getElementById('root');
if (!el) throw new Error('#root missing');

createRoot(el).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={300}>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);
