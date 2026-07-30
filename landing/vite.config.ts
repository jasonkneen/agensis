import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Allow overriding the base path at build time so the same build can be
// deployed at the root (local/Vercel/Netlify) or under a subpath
// (GitHub Pages at /<repo>/).
const base = process.env.VITE_BASE ?? '/';

export default defineConfig({
  base,
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
