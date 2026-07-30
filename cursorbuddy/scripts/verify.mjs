import { access, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

async function assertFile(relativePath) {
  const filePath = path.join(dist, relativePath);
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) {
    throw new Error(`${relativePath} is not a file`);
  }
  return readFile(filePath, 'utf8');
}

await access(dist);

const html = await assertFile('index.html');
const css = await assertFile('styles.css');
const app = await assertFile('app.js');
const config = await assertFile('config.js');
const oldAgentCopy = ['field', 'agents'].join(' ');

const checks = [
  [html.includes('<title>CursorBuddy'), 'homepage title is missing'],
  [html.includes('id="signup"'), 'signup form is missing'],
  [html.includes('data-account-surface'), 'account surface contract is missing'],
  [!html.includes(oldAgentCopy), 'homepage still contains old agent copy'],
  [css.includes('--cb-yellow'), 'neo-brutal token CSS is missing'],
  [app.includes('CursorBuddyAppConfig'), 'runtime config read is missing'],
  [config.includes('"siteUrl": "https://cursorbuddy.app"'), 'generated config is missing production siteUrl'],
  [config.includes('backendBaseUrl'), 'generated config is missing backendBaseUrl'],
];

for (const [ok, message] of checks) {
  if (!ok) throw new Error(message);
}

console.log('CursorBuddy site verified');
