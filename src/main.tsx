import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import App from './App.tsx';
import { FarmIntegrationApproval } from './components/integrations/FarmIntegrationApproval.tsx';
import { installDiagnosticsCapture } from './lib/feedbackDiagnostics.ts';
import './index.css';

// BEFORE React mounts, so the feedback report can carry the errors thrown while
// the app was still booting — the ones nobody can reproduce on request. Writes
// into a fixed-size ring buffer (see feedbackDiagnostics.ts), so an always-on
// tap on `console` cannot grow without bound in a long-lived tab. Nothing is
// sent anywhere until a user explicitly submits a report.
installDiagnosticsCapture();

// Visit /#showcase to view the shadcn component gallery without signing in.
// Dev-only: gated on import.meta.env.DEV so Rollup drops the branch (and the
// lazy chunk, and recharts with it) from production builds entirely.
const Showcase = import.meta.env.DEV
  ? lazy(() => import('./showcase/Showcase.tsx').then(m => ({ default: m.Showcase })))
  : () => null;
const isShowcase = import.meta.env.DEV && typeof window !== 'undefined' && window.location.hash.replace('#', '') === 'showcase';
// /#screens renders real window contents from the smoke fixtures — see
// sr./showcase/screens/ScreenGallery.tsx. Same DEV gate as the showcase.
const ScreenGallery = import.meta.env.DEV
  ? lazy(() => import('./showcase/screens/ScreenGallery.tsx').then(m => ({ default: m.ScreenGallery })))
  : () => null;
const isScreens = import.meta.env.DEV && typeof window !== 'undefined' && window.location.hash.replace('#', '').split('/')[0] === 'screens';
const isFarmIntegrationApproval = typeof window !== 'undefined' && window.location.pathname.replace(/\/+$/, '') === '/integrations/farm';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      {isShowcase ? <Suspense fallback={null}><Showcase /></Suspense> : isScreens ? <Suspense fallback={null}><ScreenGallery /></Suspense> : isFarmIntegrationApproval ? <FarmIntegrationApproval /> : <App />}
    </ErrorBoundary>
  </StrictMode>
);
