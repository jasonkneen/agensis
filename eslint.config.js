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
      // runs lint in the same job as the tests, that failure used to abort the
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
