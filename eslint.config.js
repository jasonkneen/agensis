import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', '.claude/**', 'build/**', 'release/**', 'landing/**'] },
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
      'netlify/functions/**/*.mjs',
      'electron/**/*.cjs',
      'visual-editor/src/**/*.cjs',
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
    files: ['shared/**/*.mjs', 'scripts/**/*.mjs', 'netlify/functions/**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
    },
  }
);
