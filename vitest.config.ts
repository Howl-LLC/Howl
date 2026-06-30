// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['__tests__/**/*.test.{ts,tsx,js}', 'scripts/**/*.test.ts'],
    setupFiles: ['__tests__/setup.ts'],
    testTimeout: 10000,
    css: false,
    // scripts/check-schema-compat.test.ts uses // @vitest-environment node
    // at the top of the file to opt out of jsdom; no global override needed.
  },
});
