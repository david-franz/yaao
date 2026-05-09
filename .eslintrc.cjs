/* eslint-env node */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  ignorePatterns: ['dist', 'node_modules', 'coverage', '*.cjs'],
  rules: {
    '@typescript-eslint/consistent-type-imports': 'error',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'no-console': 'error',
  },
  overrides: [
    {
      files: ['src/bin/**/*.ts'],
      rules: { 'no-console': 'off' },
    },
    {
      files: ['tests/**/*.ts', 'vitest.config.ts', 'tsup.config.ts'],
      rules: { 'no-console': 'off' },
    },
  ],
};
