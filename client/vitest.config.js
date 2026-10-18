import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['test/*.test.jsx'],
    restoreMocks: true,
    // Coverage instrumentation on CI runners pushes the longest UI flows past the 5 s default.
    testTimeout: 30000,
  },
});
