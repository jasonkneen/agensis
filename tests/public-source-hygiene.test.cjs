'use strict';

// The publication guard (opensourceplan.md §4).
//
// This is the gate that stands between the working tree and a public snapshot.
// It reads every file the repository would actually publish — tracked files plus
// non-ignored untracked files, exactly `git ls-files --cached --others
// --exclude-standard` — and fails with `path:line`, a category, and an excerpt
// for anything that must not ship.
//
// WHY IT IS BUILT THE WAY IT IS
//
// A hygiene gate has two failure modes and only one of them is visible. The
// obvious one is missing a violation. The quiet one is crying wolf: a rule that
// flags `TextDecoder`, a Dockerfile `COPY`, `navigator.clipboard`, `git clone`
// in the README, or the MIT licence's own "copy of this software" produces so
// much noise that the next person deletes the test rather than reads it. A gate
// nobody runs guards nothing. So the fuzzy categories here are deliberately
// TWO-SIGNAL: a transfer verb on its own is never a violation, because this
// codebase says "copied from the host", "must never reimplement the rule" and
// "extracted verbatim from server/index.cjs" in fifteen places and means its own
// internals every time. A transfer verb only fails when its OBJECT is external.
//
// Every rule below was calibrated against the real tree, and the negative
// fixtures at the bottom are the actual lines that used to trip earlier drafts.
//
// SELF-CONTAMINATION
//
// This file is scanned by its own scan; it is not on any exclusion list, and
// `exclusion list is empty` is an assertion below. That is only possible because
// no contaminated literal is ever written out here:
//   - prohibited names are stored as regex sources with one letter bracketed
//     (`hilo[s]`), which matches the real word but is not the real word;
//   - positive fixtures are assembled from fragments at runtime.
// The same trick is used in tests/unit/feedbackRedaction.test.ts, for the same
// reason: a test about a forbidden string must not itself contain it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');

// This file's own repo-relative path. Used by the anti-vacuity checks to prove
// the scan reached it — NOT to skip it.
const SELF = 'tests/public-source-hygiene.test.cjs';

// Paths the scan is allowed to skip. It is EMPTY, and a test asserts it stays
// empty. Every exclusion is a place a violation can hide, so adding one needs a
// written reason and a reviewer, not a quiet append.
const EXCLUDED_PATHS = new Set();

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

const CATEGORY = {
  PERSONAL: 'personal-source-path-or-identity',
  EXTRACTION: 'extraction/provenance marker',
  TRANSFER: 'copying/porting/imitation construction',
  IDENTITY: 'prohibited competitor/source identity',
  CLOSED: 'private/closed-source claim',
  ASSET: 'undocumented binary asset',
};

// ---------------------------------------------------------------------------
// Prohibited identities (opensourceplan.md §1 and §2)
// ---------------------------------------------------------------------------
//
// Each `word` is a REGEX SOURCE with one letter in a character class, so the
// plain name never appears in this file. `identityWord()` recovers the plain
// spelling by stripping the brackets, and a test asserts every pattern still
// matches its own recovered spelling — a typo here would otherwise produce a
// rule that silently matches nothing.
//
// What is NOT here matters as much as what is. Operational integrations,
// dependencies, runtimes and public protocols stay: Slack, Discord, Linear,
// Telegram, GitHub, Anthropic, OpenAI, Claude, Codex, Cursor, Qwen, Gemini,
// Ollama, Netlify, Fly, Neon, Supabase, LiveKit, Cartesia, Deepgram, Box —
// and, specifically called out because they read like source products and are
// not: `goose` (a supported CLI in server/lib/capabilities.cjs) and `openpets`
// (a declared third-party integration with its own routes).
const PROHIBITED_IDENTITIES = [
  { word: 'hilo[s]', why: 'source product whose API model was mirrored' },
  { word: 'openpat[h]', why: 'source product credited in a visual-editor comment' },
  { word: 'buz[z]', why: 'source product named in opensourceplan.md §2' },
  { word: 'vibecla[w]', why: 'source product named in opensourceplan.md §2' },
  { word: 'almostnod[e]', why: 'source product named in opensourceplan.md §2' },
  { word: 'clus[o]', why: 'source product named in opensourceplan.md §2' },
  { word: 'blosso[m]', why: 'source product named in opensourceplan.md §2' },
  { word: 'tinyworl[d]', why: 'source-associated theme identifier; §2 requires a rename' },
  { word: 'openagent[s]', why: 'competitor named in comparison material (§1)' },
  { word: 'agentforc[e]', why: 'competitor named in comparison material (§1)' },
];

/** The plain spelling a bracketed pattern stands for, brackets removed. */
function identityWord(source) {
  return source.replace(/[[\]]/g, '');
}

const IDENTITY_ALTERNATION = PROHIBITED_IDENTITIES.map((e) => e.word).join('|');

// ---------------------------------------------------------------------------
// Transfer language
// ---------------------------------------------------------------------------

// Verbs that DESCRIBE a transfer. On their own these are ordinary engineering
// English in this repo, so none of them fails by itself.
const TRANSFER_VERB = [
  'borrow(?:ed|ing)?',
  'copied',
  'cop(?:y|ies|ying)',
  'port(?:ed|ing)?',
  're-?implement(?:ed|ing|ation|s)?',
  're-?creat(?:e|ed|ing|ion)',
  'reverse[-\\s]?engineer(?:ed|ing)?',
  'clon(?:e|ed|ing)',
  'mirror(?:s|ed|ing)?',
  // `modelled`/`modeling` only. Bare "model" is a domain noun here (state
  // model, model selector, model id) and matches thousands of innocent lines.
  'modell?(?:ed|ing)',
  'imitat(?:e|ed|es|ing|ion)',
  'inspired',
  'lift(?:ed)?',
  'replicat(?:e|ed|es|ing|ion)',
  'verbatim',
  'transferred',
  'adapted',
  'derived',
].join('|');

// The transfer verb, in the shapes that take an object.
const TRANSFER_VERB_PHRASE =
  '(?:' +
  [
    'borrow(?:ed|ing)?\\s+from',
    'copied\\s+from',
    'cop(?:y|ies|ying)\\s+(?:of|from)',
    'port(?:ed|ing)?\\s+(?:it\\s+|this\\s+|that\\s+)?from',
    'reverse[-\\s]?engineer(?:ed|ing)?\\s+(?:from|the)?',
    're-?implement(?:ed|ing)?\\s+',
    're-?creat(?:e|ed|ing)\\s+',
    'clon(?:e|ed|ing)\\s+(?:of|from)',
    'lifted\\s+from',
    'verbatim\\s+from',
    'adapted\\s+from',
    'derived\\s+from',
    'based\\s+on',
    'inspired\\s+by',
    'modell?ed\\s+(?:on|after)',
    'imitat(?:e|ed|es|ing|ion\\s+of)\\s*',
    'replicat(?:e|ed|es|ing)\\s+',
    'transferred\\s+from',
  ].join('|') +
  ')';

// The second signal: an object that can only be something OUTSIDE this project.
//
// The determiner is the whole trick. "copied from the host", "copied from the
// hooks", "reverse-engineer from the renderer" and "reimplement the rule" all
// say `the <internal noun>` and all pass. "copied from A PRIOR hand-rolled
// implementation" and "borrowed from <name>'S inspector" name a foreign thing
// and both fail.
//
// `ui`, `client`, `app` and bare `source` are deliberately NOT in the noun list:
// the tree says "other people's UI", "one user's client", "the other from App
// state" and "their source-location stamps" in prose that has nothing to do with
// provenance.
const EXTERNAL_OBJECT =
  '(?:' +
  [
    // "another implementation", "a prior hand-rolled implementation", ...
    '(?:another|a\\s+prior|a\\s+previous|an?\\s+existing|the\\s+original|the\\s+other|' +
      'the\\s+source|their|upstream|a\\s+competing|a\\s+rival|a\\s+third[-\\s]party)' +
      '\\s+(?:\\w+[-\\s]){0,3}' +
      '(?:implementations?|codebases?|code\\s?bases?|products?|applications?|projects?|' +
      'repo(?:sitor(?:y|ies)|s)?|inspectors?|renderers?|editors?|extensions?|' +
      'librar(?:y|ies)|designs?|layouts?|panels?|versions?|approach(?:es)?)',
    // "<name>'s inspector" — a foreign product in the possessive.
    "[A-Za-z][\\w-]{2,}(?:'s|’s)\\s+" +
      '(?:implementation|inspector|renderer|editor|layout|design|version|approach|panel|codebase)',
    // The identity list itself is always an external object.
    '(?:' + IDENTITY_ALTERNATION + ')',
  ].join('|') +
  ')';

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------
//
// `allow` patterns suppress a match on the same line. Each one is a real line
// from this tree or a documented shape, never a guess.

const RULES = [
  {
    id: 'personal-home-path',
    category: CATEGORY.PERSONAL,
    // A developer's home directory. Placeholder and CI-runner names are fine —
    // `/Users/runner` is the GitHub Actions macOS runner and `/home/node` is the
    // node Docker image, both of which appear in real config.
    //
    // The lookbehind matters: without it `src/components/home/HomeCanvas.tsx`
    // reads as a home directory called "HomeCanvas.tsx". Only an ABSOLUTE
    // `/home/…` counts, so the segment must not be preceded by path or word
    // characters.
    pattern: /(?<![A-Za-z0-9_./\\-])(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)([A-Za-z0-9._-]+)/g,
    reject: (m) => {
      const name = m[1].toLowerCase();
      // A one-character home ("/home/j/…") identifies nobody; it is the shape
      // fixtures use precisely to avoid naming a person.
      if (name.length <= 1) return false;
      return !PLACEHOLDER_HOME_NAMES.has(name);
    },
  },
  {
    id: 'personal-email',
    category: CATEGORY.PERSONAL,
    // A real person's mailbox at a consumer mail provider. Fixture addresses at
    // example.com / test / localhost and the product's own agensis.io are fine.
    pattern: new RegExp(
      '[A-Za-z0-9._%+-]+@(?:gmail|googlemail|hotmail|outlook|live|yahoo|ymail|icloud|' +
        'me|mac|aol|proton|protonmail|gmx|yandex|qq|fastmail|zoho)\\.[A-Za-z.]{2,8}',
      'gi',
    ),
  },
  {
    id: 'extraction-marker',
    category: CATEGORY.EXTRACTION,
    // Markers left behind by a feature-extraction workflow. Every phrase here
    // is unconditional, so each one had to survive a sweep of the whole tree
    // with zero hits before it went in. The trailing word boundary is what
    // keeps the first alternative off the words "source package".
    //
    // "lifted from" is deliberately NOT here. This tree says "a template lifted
    // from elsewhere in the page" and "Lifted from the presence/avatar cluster"
    // about its own internals, so it is handled two-signal below instead.
    pattern: new RegExp(
      '\\b(?:source[-_\\s]?pack|feature[-_\\s]?pack|extraction\\s+(?:marker|manifest|pack|bundle)|' +
        'extracted\\s+wholesale|taken\\s+verbatim|' +
        'feature[-\\s]transfer|directly\\s+portable|straight\\s+port\\s+of|1:1\\s+port|' +
        'pixel[-\\s]for[-\\s]pixel\\s+(?:copy|clone))\\b',
      'gi',
    ),
  },
  {
    id: 'transfer-with-external-object',
    category: CATEGORY.TRANSFER,
    // Two-signal: a transfer verb whose object is external. A verb pointing at
    // one of this project's own nouns passes; a verb pointing at a foreign
    // product, or at a foreign product's named part, does not.
    pattern: new RegExp(TRANSFER_VERB_PHRASE + '[^.\\n]{0,40}?' + EXTERNAL_OBJECT, 'gi'),
  },
  {
    id: 'transfer-near-prohibited-identity',
    category: CATEGORY.TRANSFER,
    // Two-signal: any transfer verb within 80 characters of a prohibited name,
    // in either order. Reported separately from the bare identity hit because
    // the remedy is different — this one needs the sentence rewritten, not just
    // the name swapped.
    //
    // Both boundaries on the verb are load-bearing. Without the LEADING one,
    // `export type ThemeMode = …` matches on the "port" inside "export".
    pattern: new RegExp(
      '(?:\\b(?:' + TRANSFER_VERB + ')\\b[^\\n]{0,80}?\\b(?:' + IDENTITY_ALTERNATION + ')\\b' +
        '|\\b(?:' + IDENTITY_ALTERNATION + ')\\b[^\\n]{0,80}?\\b(?:' + TRANSFER_VERB + ')\\b)',
      'gi',
    ),
  },
  {
    id: 'prohibited-identity',
    category: CATEGORY.IDENTITY,
    pattern: new RegExp('\\b(?:' + IDENTITY_ALTERNATION + ')\\b', 'gi'),
  },
  {
    id: 'closed-source-claim',
    category: CATEGORY.CLOSED,
    // Anchored on a repo-shaped noun so the hundreds of ordinary uses of
    // "private" survive: `private: true`, `visibility = 'private'`,
    // `private sources = new Set<AudioBufferSourceNode>()`, private sessions,
    // private DM lanes.
    pattern: new RegExp(
      '(?:' +
        [
          '\\b(?:this|the)\\s+(?:repo(?:sitory)?|project|codebase|app|application|backend|' +
            'desktop\\s+app|frontend)\\b[^.\\n]{0,40}?\\b(?:is|remains|stays|will\\s+remain)\\b' +
            '[^.\\n]{0,25}?\\b(?:private|closed[-\\s]source|proprietary|unpublished|' +
            'not\\s+(?:yet\\s+)?open[-\\s]source)\\b',
          '\\b(?:private|closed[-\\s]source|proprietary|internal[-\\s]only)\\s+' +
            '(?:repo(?:sitory)?|codebase|source\\s+code|monorepo)\\b',
          '\\b(?:source|code|repo(?:sitory)?|codebase)\\s+is\\s+not\\s+public\\b',
          '\\bwill\\s+never\\s+be\\s+(?:open[-\\s]sourced?|published|public)\\b',
          '\\bdo(?:es)?\\s+not\\s+open[-\\s]source\\b',
        ].join('|') +
        ')',
      'gi',
    ),
  },
];

// Home-directory names that are placeholders, CI runners or container users
// rather than a person.
const PLACEHOLDER_HOME_NAMES = new Set([
  // Written into UI placeholder text and docs: "/Users/name/Documents/…".
  'name', 'user', 'users', 'username', 'owner', 'you', 'me', 'someone',
  'example', 'placeholder', 'demo', 'sample', 'alice', 'bob',
  // CI runners and container users that appear in real workflow/Docker config.
  'runner', 'node', 'root', 'ubuntu', 'vscode', 'circleci', 'travis', 'jenkins',
  'linuxbrew', 'shared', 'app', 'appuser', 'nonroot', 'dev', 'developer',
  'test', 'ci',
]);

// ---------------------------------------------------------------------------
// Binary assets
// ---------------------------------------------------------------------------

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.icns', '.bmp',
  '.tif', '.tiff', '.psd', '.ai', '.sketch', '.fig',
  '.mp3', '.wav', '.ogg', '.flac', '.m4a', '.mp4', '.mov', '.webm', '.avi',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.pdf', '.zip', '.gz', '.tgz', '.bz2', '.xz', '.tar', '.7z', '.rar',
  '.wasm', '.node', '.dylib', '.so', '.dll', '.exe', '.bin', '.dmg',
  '.sqlite', '.sqlite3', '.db', '.pack', '.idx', '.jar', '.class',
]);

// Where an asset inventory may live. opensourceplan.md §3 asks for `ASSETS.md`
// or an equivalent third-party notice.
const ASSET_MANIFESTS = ['ASSETS.md', 'NOTICE', 'NOTICE.md', 'THIRD-PARTY-NOTICES.md', 'docs/ASSETS.md'];

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/**
 * Every file a public snapshot of this tree would contain.
 *
 * This is the plan's exact command. `--cached` covers tracked files, `--others
 * --exclude-standard` covers untracked files that .gitignore does NOT exclude —
 * the ones that would be swept into a fresh commit and are otherwise invisible
 * to a tracked-only scan.
 */
function listRepoFiles() {
  const out = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return out.split('\0').filter(Boolean).filter((p) => !EXCLUDED_PATHS.has(p));
}

function isBinaryPath(relPath, buffer) {
  if (BINARY_EXTENSIONS.has(path.extname(relPath).toLowerCase())) return true;
  // Backstop for extensionless binaries: a NUL byte in the first 8 KiB.
  return buffer.subarray(0, 8192).includes(0);
}

/**
 * Run every rule over one file's text.
 *
 * Exported shape (`{ file, line, category, ruleId, excerpt }`) is what the
 * failure message prints, so a finding is always actionable without re-running
 * anything.
 */
function scanText(relPath, text) {
  const findings = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    for (const rule of RULES) {
      rule.pattern.lastIndex = 0;
      let m;
      while ((m = rule.pattern.exec(line)) !== null) {
        if (m[0] === '') { rule.pattern.lastIndex += 1; continue; }
        if (rule.reject && !rule.reject(m)) continue;
        findings.push({
          file: relPath,
          line: i + 1,
          category: rule.category,
          ruleId: rule.id,
          excerpt: excerpt(line, m.index),
        });
        break; // one finding per rule per line is enough to act on
      }
    }
  }
  return findings;
}

function excerpt(line, at) {
  const start = Math.max(0, at - 30);
  const slice = line.slice(start, start + 140).trim();
  return (start > 0 ? '…' : '') + slice + (start + 140 < line.length ? '…' : '');
}

/** Parsed asset manifest text, or null when the repo has no manifest at all. */
function readAssetManifest() {
  const found = [];
  for (const rel of ASSET_MANIFESTS) {
    try {
      found.push(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
    } catch { /* not present */ }
  }
  return found.length ? found.join('\n') : null;
}

/**
 * A binary is documented when the manifest names its path, or names a directory
 * prefix that contains it (`images/` documents `images/download-01.jpg`).
 */
function isDocumentedAsset(relPath, manifest) {
  if (!manifest) return false;
  if (manifest.includes(relPath)) return true;
  const parts = relPath.split('/');
  for (let i = parts.length - 1; i > 0; i -= 1) {
    if (manifest.includes(parts.slice(0, i).join('/') + '/')) return true;
  }
  return false;
}

/** The whole-repository scan. Memoised: it reads ~25 MB. */
let cached = null;
function scanRepository() {
  if (cached) return cached;
  const files = listRepoFiles();
  const manifest = readAssetManifest();
  const findings = [];
  const textFiles = [];
  const binaryFiles = [];
  let bytesScanned = 0;
  let linesScanned = 0;

  for (const rel of files) {
    const abs = path.join(REPO_ROOT, rel);
    let stat;
    try {
      stat = fs.lstatSync(abs);
    } catch {
      continue; // raced deletion; nothing to publish
    }
    if (!stat.isFile()) continue; // symlinks are not content
    const buf = fs.readFileSync(abs);
    if (isBinaryPath(rel, buf)) {
      binaryFiles.push(rel);
      if (!isDocumentedAsset(rel, manifest)) {
        findings.push({
          file: rel,
          line: 0,
          category: CATEGORY.ASSET,
          ruleId: 'undocumented-binary-asset',
          excerpt: `${(stat.size / 1024).toFixed(0)} KiB binary with no entry in ${ASSET_MANIFESTS[0]}`,
        });
      }
      continue;
    }
    const text = buf.toString('utf8');
    textFiles.push(rel);
    bytesScanned += buf.length;
    linesScanned += text.split('\n').length;
    findings.push(...scanText(rel, text));
  }

  cached = { files, textFiles, binaryFiles, findings, bytesScanned, linesScanned, hasManifest: manifest !== null };
  return cached;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const MAX_REPORTED_PER_CATEGORY = 25;

function report(findings, heading) {
  const byFile = new Map();
  for (const f of findings) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file).push(f);
  }
  const lines = [
    '',
    `${heading}: ${findings.length} finding(s) in ${byFile.size} file(s).`,
    '',
  ];
  let shown = 0;
  let filesShown = 0;
  for (const [, group] of byFile) {
    if (shown >= MAX_REPORTED_PER_CATEGORY) break;
    filesShown += 1;
    for (const f of group.slice(0, 3)) {
      lines.push(`  ${f.file}:${f.line}  [${f.category} / ${f.ruleId}]`);
      lines.push(`      ${f.excerpt}`);
      shown += 1;
      if (shown >= MAX_REPORTED_PER_CATEGORY) break;
    }
    if (group.length > 3) lines.push(`      (+${group.length - 3} more in this file)`);
  }
  if (filesShown < byFile.size) {
    lines.push(`  … plus findings in ${byFile.size - filesShown} further file(s).`);
  }
  lines.push('');
  lines.push('  Fix the source, do not add an exclusion. See opensourceplan.md section 4.');
  return lines.join('\n');
}

function findingsFor(category) {
  return scanRepository().findings.filter((f) => f.category === category);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
//
// Positive fixtures are ASSEMBLED, never written out, so this file stays clean
// under its own scan. `j()` exists purely to keep the fragments apart in the
// source text.
const j = (...parts) => parts.join('');

function positiveFixtures() {
  // Recovered at runtime, never spelled out — see the header note. The variable
  // name is deliberately generic for the same reason.
  const foreignProduct = identityWord(PROHIBITED_IDENTITIES[1].word);
  return [
    {
      why: 'a developer home directory',
      category: CATEGORY.PERSONAL,
      text: j('const root = "', '/Users', '/', 'somedeveloper', '/Documents/GitHub/thing";'),
    },
    {
      why: 'a windows developer home directory',
      category: CATEGORY.PERSONAL,
      text: j('C:', '\\', 'Users', '\\', 'somedeveloper', '\\src\\app'),
    },
    {
      why: 'a real mailbox at a consumer provider',
      category: CATEGORY.PERSONAL,
      text: j('owner: "', 'someperson', '@', 'gmail.com', '",'),
    },
    {
      why: 'an extraction-workflow marker',
      category: CATEGORY.EXTRACTION,
      text: j('// ', 'source', '-', 'pack', ' entry 14 — shadow ladder'),
    },
    {
      why: 'a portability claim',
      category: CATEGORY.EXTRACTION,
      text: j('// this module is ', 'directly', ' ', 'portable', ' and needs no changes'),
    },
    {
      why: 'a transfer verb with an external object',
      category: CATEGORY.TRANSFER,
      text: j('// State model (', 'copied', ' ', 'from', ' a prior hand-rolled implementation)'),
    },
    {
      why: 'a transfer verb with a foreign possessive object',
      category: CATEGORY.TRANSFER,
      text: j('/** Shadow preset ladder (', 'borrowed', ' ', 'from', ' ', foreignProduct, "'s inspector) */"),
    },
    {
      why: 'a transfer verb beside a prohibited identity',
      category: CATEGORY.TRANSFER,
      text: j('// ', 'Mirrors', ' the ', identityWord(PROHIBITED_IDENTITIES[0].word), ' /api/mcp model.'),
    },
    {
      why: 'a bare prohibited identity',
      category: CATEGORY.IDENTITY,
      text: j('<td>vs ', identityWord(PROHIBITED_IDENTITIES[8].word), ', alternatives</td>'),
    },
    {
      why: 'a closed-source claim about the repository',
      category: CATEGORY.CLOSED,
      text: j('This ', 'repository', ' ', 'is', ' ', 'private', ' and must not be shared.'),
    },
    {
      why: 'a closed-source claim in noun form',
      category: CATEGORY.CLOSED,
      text: j('Contributions are not accepted into this ', 'proprietary', ' ', 'codebase', '.'),
    },
    {
      why: 'a never-publish claim',
      category: CATEGORY.CLOSED,
      text: j('The desktop shell ', 'will', ' ', 'never', ' ', 'be', ' ', 'published', '.'),
    },
  ];
}

// Negative fixtures are written out literally on purpose: if any of them were
// actually a violation this file's own scan would say so, which is a second,
// free check that they really are benign. Every line here is either a real line
// from this tree or the documented shape of one.
const NEGATIVE_FIXTURES = [
  // Decoding, not "decoding another product".
  "const text = new TextDecoder('utf-8').decode(bytes);",
  'const name = decodeURIComponent(url.searchParams.get("name") ?? "");',
  'const href = encodeURI(`${base}/${encodeURIComponent(slug)}`);',
  // Clipboard.
  'await navigator.clipboard.writeText(value); // copy to clipboard',
  '<button onClick={copyLink}>Copy link</button>',
  // Dockerfile.
  'COPY . /app',
  'COPY --from=builder /app/dist ./dist',
  'COPY package.json package-lock.json ./',
  // Ports.
  'server.listen(3000, () => log("up"));',
  'const port = Number(process.env.PORT ?? 8080);',
  '// the daemon\'s dev-port rewrite, reimplemented in ~10 lines.',
  // Cloning a git repo.
  'git clone https://github.com/jasonkneen/agensis.git',
  'never reimplement `Bash(git clone:*)` matching, so we cannot drift from it,',
  // Internal parity / internal duplication language — the biggest false-positive
  // family in this repo. All of these are real lines.
  '// canvas_id copied from the host) where speech-to-text and the agents\' replies',
  "assert.match(statement[0], /host\\.participants/, 'participants must be copied from the host');",
  '// The binding shapes are COPIED from the hooks rather than paraphrased — the',
  '// rule — a stub that reimplements the WHERE clause measures the stub. The',
  '//   - `state` is the same fold for consumers that should not reimplement it',
  '// taking one injected function and cannot reimplement the rule.',
  '//     deliberately NOT reimplemented here: this repo already has one live SSRF',
  '// Resolves a session\'s workspace. Injected rather than reimplemented: the',
  '// an extracted module must never reimplement one.',
  '// will otherwise have to reverse-engineer from the renderer:',
  '// Routes extracted verbatim from server/index.cjs (Wave 2 of the index.cjs',
  '# The docs are plain static HTML under public/docs/, copied verbatim into',
  '// libraries are copied into the project rather than imported from a package:',
  '//     how a previous implementation claimed "1 participant" forever).',
  '// that puts one person\'s words into everybody else\'s UI. Every one of them',
  '// Sideways: clientB\'s editor must not.',
  'There are two independent lanes and they must not be joined upstream of the UI.',
  '// from a hook (null before a workspace loads) and the other from App state',
  // Licence text.
  'Permission is hereby granted, free of charge, to any person obtaining a copy',
  'of this software and associated documentation files (the "Software"), to deal',
  'The above copyright notice and this permission notice shall be included in all',
  'copies or substantial portions of the Software.',
  // Operational providers and integrations, including the two that read like
  // source products and are not.
  "{ id: 'goose', label: 'Goose', command: 'goose' },",
  '// skills-compatible client (Claude Code, Codex, Cursor, Gemini CLI, Goose, ...)',
  "import { mountPetsRoutes } from './pets-routes.cjs'; // openpets integration",
  'Slack, Discord, Linear and Telegram bridges share one signing helper.',
  'Providers: Anthropic, OpenAI, Cartesia, Deepgram, LiveKit, Neon, Netlify, Fly.',
  // "private" in its ordinary senses.
  '"private": true,',
  "`chat_sessions.visibility = 'private'` is readable only by rows in",
  'private sources = new Set<AudioBufferSourceNode>();',
  'private source: MediaStreamAudioSourceNode | null = null;',
  '| `isPrivateSessionRow(row)` | is this session members-only? |',
  '**A private session is a DM, or anything derived from one.** Sub-thread splits',
  'Two things to know before editing it: the package is `private: true` so there is',
  // CI and container home directories.
  'working-directory: /Users/runner/work/agensis/agensis',
  'WORKDIR /home/node/app',
  'const home = process.env.HOME ?? "/home/user";',
  // Fixture email addresses.
  "email: 'owner@example.com',",
  'const to = "someone@test.local";',
];

// ---------------------------------------------------------------------------
// Anti-vacuity: prove the scan ran, covered the repo, and can actually fail
// ---------------------------------------------------------------------------

test('anti-vacuity: the scan reads a real, repo-sized file list', () => {
  const scan = scanRepository();
  assert.ok(scan.files.length > 500, `expected the publish set to be repo-sized, got ${scan.files.length} files`);
  assert.ok(scan.textFiles.length > 400, `expected hundreds of text files, got ${scan.textFiles.length}`);
  assert.ok(scan.bytesScanned > 1_000_000, `expected >1 MB of text scanned, got ${scan.bytesScanned} bytes`);
  assert.ok(scan.linesScanned > 50_000, `expected >50k lines scanned, got ${scan.linesScanned}`);
});

test('anti-vacuity: the scan covers this file and every major source tree', () => {
  const scan = scanRepository();
  const set = new Set(scan.textFiles);
  // If this file were skipped, its own fixtures could hide anything.
  assert.ok(set.has(SELF), `${SELF} was not scanned — the guard must scan itself`);
  for (const sentinel of [
    'package.json', 'AGENTS.md', 'README.md',
    'server/index.cjs', 'src/App.tsx', 'shared/backend-core.cjs',
    'tests/backend-auth.test.cjs', 'visual-editor/src/client.js',
  ]) {
    assert.ok(set.has(sentinel), `${sentinel} was not scanned — a whole tree is missing from the file list`);
  }
  // Every top-level directory that holds text must be represented, so a scan
  // that silently drops a subtree fails here rather than passing green.
  const topLevel = new Set(scan.textFiles.filter((p) => p.includes('/')).map((p) => p.split('/')[0]));
  for (const dir of ['src', 'server', 'shared', 'tests', 'cli', 'scripts', 'database', 'public', 'visual-editor']) {
    assert.ok(topLevel.has(dir), `no file under ${dir}/ was scanned`);
  }
});

test('anti-vacuity: nothing is excluded from the scan', () => {
  assert.equal(
    EXCLUDED_PATHS.size, 0,
    `EXCLUDED_PATHS must stay empty; every exclusion is a place a violation can hide. Found: ${[...EXCLUDED_PATHS].join(', ')}`,
  );
});

test('anti-vacuity: every rule fires on a planted violation', () => {
  const missed = [];
  for (const fixture of positiveFixtures()) {
    const hits = scanText('fixture.ts', fixture.text);
    if (!hits.some((h) => h.category === fixture.category)) {
      missed.push(`${fixture.why} → expected category "${fixture.category}", got [${hits.map((h) => h.ruleId).join(', ') || 'nothing'}]`);
    }
  }
  assert.deepEqual(missed, [], `the detector is blind to:\n  ${missed.join('\n  ')}`);
});

test('anti-vacuity: every prohibited identity pattern matches the word it stands for', () => {
  // A bracketed source with a typo — `openpaht[h]` — would compile fine and
  // match nothing forever. This is the check that makes that impossible.
  for (const entry of PROHIBITED_IDENTITIES) {
    const word = identityWord(entry.word);
    const hits = scanText('fixture.md', `the ${word} project`);
    assert.ok(
      hits.some((h) => h.category === CATEGORY.IDENTITY),
      `identity pattern "${entry.word}" does not match "${word}" (${entry.why})`,
    );
  }
});

test('anti-vacuity: the end-to-end scan really reads files off disk', async (t) => {
  // The checks above prove the rules work on strings and that the file LIST is
  // real. This one closes the gap between them: it plants a contaminated
  // untracked file in the working tree, runs the same `git ls-files` +
  // read + scan path the gate uses, and requires the finding to come back.
  //
  // If the scan ever stops reading file contents — a swallowed readFileSync,
  // an over-eager binary sniff, a `continue` in the wrong branch — this is the
  // test that goes red.
  const canaryRel = 'tests/.public-source-hygiene-canary.tmp';
  const canaryAbs = path.join(REPO_ROOT, canaryRel);
  const planted = positiveFixtures().map((f) => f.text).join('\n');
  t.after(() => { try { fs.unlinkSync(canaryAbs); } catch { /* already gone */ } });

  fs.writeFileSync(canaryAbs, planted, 'utf8');
  try {
    // A fresh, un-memoised scan of the live tree.
    const files = listRepoFiles();
    assert.ok(files.includes(canaryRel), 'git ls-files did not report the planted file — the scan cannot see new files');
    const text = fs.readFileSync(canaryAbs, 'utf8');
    const hits = scanText(canaryRel, text);
    const categories = new Set(hits.map((h) => h.category));
    for (const expected of [CATEGORY.PERSONAL, CATEGORY.EXTRACTION, CATEGORY.TRANSFER, CATEGORY.IDENTITY, CATEGORY.CLOSED]) {
      assert.ok(categories.has(expected), `planted file was not flagged for ${expected}`);
    }
    assert.ok(hits.every((h) => h.file === canaryRel && h.line > 0), 'findings must carry path:line');
  } finally {
    fs.unlinkSync(canaryAbs);
  }
});

test('ordinary code and documentation is not flagged', () => {
  // The gate is only useful if people leave it switched on. Every line here is
  // legitimate; a single hit means the rules have started crying wolf.
  const noise = [];
  for (const line of NEGATIVE_FIXTURES) {
    for (const hit of scanText('fixture', line)) {
      noise.push(`  [${hit.ruleId}] ${line}\n      matched: ${hit.excerpt}`);
    }
  }
  assert.deepEqual(noise, [], `these legitimate lines were flagged:\n${noise.join('\n')}`);
});

// ---------------------------------------------------------------------------
// The policy itself
// ---------------------------------------------------------------------------

test('no personal source paths or personal identities', () => {
  const hits = findingsFor(CATEGORY.PERSONAL);
  assert.equal(hits.length, 0, report(hits, 'Personal paths/identities in the publish set'));
});

test('no extraction or provenance markers', () => {
  const hits = findingsFor(CATEGORY.EXTRACTION);
  assert.equal(hits.length, 0, report(hits, 'Extraction/provenance markers in the publish set'));
});

test('no copying, porting, reverse-engineering or imitation constructions', () => {
  const hits = findingsFor(CATEGORY.TRANSFER);
  assert.equal(hits.length, 0, report(hits, 'Provenance-transfer language in the publish set'));
});

test('no prohibited competitor or source identities', () => {
  const hits = findingsFor(CATEGORY.IDENTITY);
  assert.equal(hits.length, 0, report(hits, 'Prohibited identities in the publish set'));
});

test('no private or closed-source claims', () => {
  const hits = findingsFor(CATEGORY.CLOSED);
  assert.equal(hits.length, 0, report(hits, 'Closed-source claims in the publish set'));
});

test('every shipped binary asset is documented', () => {
  const scan = scanRepository();
  const hits = findingsFor(CATEGORY.ASSET);
  assert.ok(scan.binaryFiles.length > 0, 'no binary files were classified — the asset check is not running');
  assert.equal(
    hits.length, 0,
    report(hits, scan.hasManifest
      ? 'Binary assets with no manifest entry'
      : `No asset manifest exists (looked for ${ASSET_MANIFESTS.join(', ')}), so every binary is undocumented`),
  );
});

module.exports = { scanText, scanRepository, listRepoFiles, RULES, CATEGORY, PROHIBITED_IDENTITIES };
