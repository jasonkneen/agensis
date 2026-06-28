# agensis — Landing page

Marketing site for agensis. This is an independent Vite + React + TypeScript +
Tailwind project, kept in its own folder so it can be deployed separately from the
app itself.

## Develop

```bash
cd landing
npm install
npm run dev
```

## Build

```bash
npm run build
```

The production build is emitted to `landing/dist/` and is fully static — deploy
it on any static host (Vercel, Netlify, Cloudflare Pages, GitHub Pages, S3, etc.)
by pointing the host at this subfolder and using `npm run build` with a publish
directory of `dist`.

## Typecheck

```bash
npm run typecheck
```
