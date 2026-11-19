import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { 'cloudflare:email': fileURLToPath(new URL('./tests/stubs/cloudflare-email.ts', import.meta.url)) } },
  test: { environment: 'node', testTimeout: 60_000 },
});
