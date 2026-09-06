import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Mirrors the "@/*" path mapping in tsconfig.json.
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // scripts/aivis-smoke.mjs is a manual integration smoke and is never run here.
    exclude: ['node_modules/**', '.next/**', 'scripts/**'],
  },
});
