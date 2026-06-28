import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import App from './App.tsx';
import { Showcase } from './showcase/Showcase.tsx';
import './index.css';

// Visit /#showcase to view the shadcn component gallery without signing in.
const isShowcase = typeof window !== 'undefined' && window.location.hash.replace('#', '') === 'showcase';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      {isShowcase ? <Showcase /> : <App />}
    </ErrorBoundary>
  </StrictMode>
);
