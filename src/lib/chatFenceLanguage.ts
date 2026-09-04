const BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  json: 'json',
  jsonc: 'jsonc',
  css: 'css',
  scss: 'scss',
  html: 'html',
  htm: 'html',
  svg: 'xml',
  xml: 'xml',
  md: 'markdown',
  mdx: 'mdx',
  zig: 'zig',
  zon: 'zig',
  rs: 'rust',
  go: 'go',
  py: 'python',
  rb: 'ruby',
  php: 'php',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'fish',
  sql: 'sql',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  env: 'dotenv',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  lock: 'yaml',
};

function looksLikeLocation(token: string): boolean {
  return token.includes('/') || token.includes(':') || token.includes('\\');
}

export function languageForLocation(token: string): string {
  const file = token.split(/[/\\]/).pop() ?? token;
  const cleaned = file.split('#')[0]!.replace(/[,)\]]+$/, '');
  const name = cleaned.toLowerCase();
  if (BY_EXTENSION[name]) return BY_EXTENSION[name];
  const dot = name.lastIndexOf('.');
  if (dot < 0) return '';
  return BY_EXTENSION[name.slice(dot + 1)] ?? '';
}

/**
 * Agents often put a file location in a fence's language slot. Preserve that
 * label as metadata while giving Shiki the real language inferred from the
 * file extension.
 */
export function normalizeFenceLanguages(markdown: string): string {
  if (!markdown.includes('```') && !markdown.includes('~~~')) return markdown;
  const lines = markdown.split('\n');
  let inFence = false;
  let fence = '';

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const open = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(line);
    if (!open) continue;
    const [, indent, ticks, rest] = open;

    if (inFence) {
      if (ticks.length >= fence.length && ticks[0] === fence[0] && !rest.trim()) inFence = false;
      continue;
    }

    inFence = true;
    fence = ticks;
    const info = rest.trim();
    if (!info) continue;
    const [token, ...meta] = info.split(/\s+/);
    if (!token || !looksLikeLocation(token)) continue;
    const language = languageForLocation(token);
    if (!language) continue;
    lines[index] = `${indent}${ticks}${language} ${[token, ...meta].join(' ')}`;
  }

  return lines.join('\n');
}
