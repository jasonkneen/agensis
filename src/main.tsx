import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import App from './App.tsx';
import './index.css';

// Visit /#showcase to view the shadcn component gallery without signing in.
// Lazy-loaded so the dev-only gallery (~2.5k LOC) is code-split into its own
// chunk instead of shipping in the main production bundle (L7, 2026-07 review).
const Showcase = lazy(() => import('./showcase/Showcase.tsx').then(m => ({ default: m.Showcase })));
const isShowcase = typeof window !== 'undefined' && window.location.hash.replace('#', '') === 'showcase';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      {isShowcase ? <Suspense fallback={null}><Showcase /></Suspense> : <App />}
    </ErrorBoundary>
  </StrictMode>
);
