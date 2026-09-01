import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // 'dist' is root-relative in flat config, so a built library needs naming
  // separately — without 'packages/*/dist' the 91 TS rules get applied to
  // packages/ui/dist/*.d.ts the moment anyone runs `npm run ui:build`.
  { ignores: ['dist', 'packages/*/dist/**', '.netlify/**', '.claude/**', '.worktrees/**', 'build/**', 'release/**', 'landing/**'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  },
  {
    // Backend/tooling: plain Node CJS/ESM, not covered by the TS block above.
    // NOTE: keep the extensions here honest — `shared/**/*.mjs` used to be listed
    // while the only file in shared/ is `backend-core.cjs`, so the file owning
    // auth, RBAC and both rate limiters had ZERO rules applied. The
    // `lint-coverage` test now fails if that regresses.
    files: [
      'server/**/*.cjs',
      'scripts/**/*.{cjs,mjs}',
      'shared/**/*.{cjs,mjs}',
      // The operator CLI. It resolves and holds a bearer token and owns the
      // redaction that keeps it out of stdout, so it belongs with the backend
      // rather than in the unlinted gap this comment block exists to warn about.
      'cli/**/*.mjs',
      'netlify/functions/**/*.mjs',
      'electron/**/*.cjs',
      // The test harness's own machinery. tests/helpers/test-env.cjs is what
      // keeps a developer's real credentials out of every test process, so it is
      // the last file in tests/ that should run with zero rules. (The 1200-odd
      // `tests/*.test.cjs` files are still unmatched by any block — a separate,
      // pre-existing gap: `npx eslint tests/` reports 5 errors today.)
      'tests/helpers/**/*.cjs',
    ],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      // `_`-prefixed identifiers are the repo's convention for "deliberately
      // unused" (destructured-and-discarded params, placeholder catch bindings).
      // Without this, six such vars fail the whole lint run — and because CI
      // used to run lint in the same job as the tests, that failure aborted the
      // job before either suite executed.
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
    },
  },
  {
    files: ['shared/**/*.mjs', 'scripts/**/*.mjs', 'netlify/functions/**/*.mjs', 'cli/**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
    },
  },
  {
    // The 57 files in src/components/ui/ are temporary re-export shims for
    // @agensis/ui (`export * from '@agensis/ui/components/<x>'`). react-refresh
    // cannot see through a star re-export, so each one raised
    // "can't verify that `export *` only exports components" — 57 warnings that
    // took the repo from 30 to 87 and buried the 18 real ones. The shims are
    // deleted once call sites are rewritten to import the package directly;
    // this block goes with them.
    files: ['src/components/ui/*.tsx'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  }
);
