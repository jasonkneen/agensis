import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src');
const dist = path.join(root, 'dist');

const config = {
  siteUrl: process.env.CURSORBUDDY_SITE_URL || 'https://cursorbuddy.app',
  backendBaseUrl: process.env.CURSORBUDDY_BACKEND_BASE_URL || '',
  bundleBaseUrl: process.env.CURSORBUDDY_BUNDLE_BASE_URL || '',
  agensisHomeUrl: process.env.CURSORBUDDY_AGENSIS_HOME_URL || 'https://agensis.io',
};

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(src, dist, { recursive: true });
await writeFile(
  path.join(dist, 'config.js'),
  `window.CursorBuddyAppConfig = ${JSON.stringify(config, null, 2)};\n`,
  'utf8',
);
