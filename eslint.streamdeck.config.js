// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
// Enforces the E2EE boundary for Stream Deck bridge code.
// No bridge code may import Howl's crypto / DM / Prisma modules.
//
// `no-restricted-imports` catches ES `import` statements (ESM / TS).
// For CJS `require()` in electron/streamdeck/*.js, the companion
// boundary grep test (__tests__/streamdeck/boundary.test.ts) provides
// source-level enforcement.
export default {
  files: ['electron/streamdeck/**/*.js', 'streamdeck-plugin/**/*.{js,ts}'],
  languageOptions: {
    globals: {
      require: 'readonly',
      module: 'readonly',
      exports: 'readonly',
      __dirname: 'readonly',
      __filename: 'readonly',
      process: 'readonly',
      console: 'readonly',
      Buffer: 'readonly',
      setTimeout: 'readonly',
      setInterval: 'readonly',
      clearTimeout: 'readonly',
      clearInterval: 'readonly',
      setImmediate: 'readonly',
      clearImmediate: 'readonly',
      URL: 'readonly',
      URLSearchParams: 'readonly',
    },
  },
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [
        { group: ['**/secureDmCrypto*'],      message: 'E2EE boundary: bridge must not import secureDmCrypto.' },
        { group: ['**/secureDmKeyManager*'],  message: 'E2EE boundary: bridge must not import secureDmKeyManager.' },
        { group: ['**/dmEncryption*'],        message: 'E2EE boundary: bridge must not import dmEncryption.' },
        { group: ['**/fileCrypto*'],          message: 'E2EE boundary: bridge must not import fileCrypto.' },
        { group: ['**/generated/prisma-*/**'], message: 'Bridge must not import Prisma client.' },
        { group: ['**/backend/src/**'],       message: 'Bridge must not import backend modules.' },
      ],
    }],
    // Allow destructure-to-omit (e.g. `({ token, ...rest }) => rest`) and
    // intentional unused vars/args prefixed with `_`.
    'no-unused-vars': ['error', { ignoreRestSiblings: true, argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  },
};
