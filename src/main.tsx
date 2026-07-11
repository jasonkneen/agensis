import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import App from './App.tsx';
import { FarmIntegrationApproval } from './components/integrations/FarmIntegrationApproval.tsx';
import './index.css';

// Visit /#showcase to view the shadcn component gallery without signing in.
// Dev-only: gated on import.meta.env.DEV so Rollup drops the branch (and the
// lazy chunk, and recharts with it) from production builds entirely.
const Showcase = import.meta.env.DEV
  ? lazy(() => import('./showcase/Showcase.tsx').then(m => ({ default: m.Showcase })))
  : () => null;
const isShowcase = import.meta.env.DEV && typeof window !== 'undefined' && window.location.hash.replace('#', '') === 'showcase';
const isFarmIntegrationApproval = typeof window !== 'undefined' && window.location.pathname.replace(/\/+$/, '') === '/integrations/farm';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      {isShowcase ? <Suspense fallback={null}><Showcase /></Suspense> : isFarmIntegrationApproval ? <FarmIntegrationApproval /> : <App />}
    </ErrorBoundary>
  </StrictMode>
);
