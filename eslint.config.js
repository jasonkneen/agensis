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
    // `shared/**/*.cjs` matters: backend-core.cjs holds auth, RBAC and the rate
    // limiters, and the old `shared/**/*.mjs`-only glob never matched it, so the
    // most security-sensitive file in the repo was linted by zero rules.
    files: ['server/**/*.cjs', 'scripts/**/*.cjs', 'shared/**/*.{mjs,cjs}', 'netlify/functions/**/*.mjs', 'electron/**/*.cjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      // A leading underscore is this repo's existing marker for a deliberately
      // unused binding (destructured-to-discard, signature-shape params). Honour
      // it instead of leaving 6 permanent errors that make the lint job red on
      // every push — a check nobody can ever get to green is a check nobody reads.
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['shared/**/*.mjs', 'netlify/functions/**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
    },
  }
);
