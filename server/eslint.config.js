const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: [
      'coverage/**',
      'integration-test/**',
      'migrations/**',
      'node_modules/**',
      'test/**',
    ],
  },
  {
    files: ['server.js', 'src/**/*.js', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      globals: globals.node,
      sourceType: 'commonjs',
    },
    rules: {
      ...js.configs.recommended.rules,
      // Existing control-character stripping is intentional; changing it is not a tooling concern.
      'no-control-regex': 'off',
      // Surface legacy cleanup candidates without forcing behavior-adjacent edits in this phase.
      'no-useless-assignment': 'warn',
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
    },
  },
];
