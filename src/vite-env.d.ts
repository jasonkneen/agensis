/// <reference types="vite/client" />

interface Window {
  electronAPI?: {
    pickFolder: () => Promise<string | null>;
  };
}
