import { readFile, unlink, access } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Nitro's netlify-static preset writes this fallback when 404.html exists.
// Netlify processes _redirects BEFORE netlify.toml, so it swallows /app,
// /integrations, /join and every other application rewrite. netlify.toml already
// owns the final 404 rule. Remove only this known generated artifact; refuse
// unfamiliar rules so a future generator change cannot silently drop routes.
export async function finalizeStaticRouting(publicDir) {
  await access(path.join(publicDir, 'index.html'));
  const redirectsPath = path.join(publicDir, '_redirects');
  let contents;
  try {
    contents = await readFile(redirectsPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (contents.trim() !== '/* /404.html 404') {
    throw new Error('Unexpected generated _redirects rules; reconcile them with netlify.toml before publishing.');
  }
  await unlink(redirectsPath);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await finalizeStaticRouting(path.resolve('dist'));
}
