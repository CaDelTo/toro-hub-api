import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      // URLs ficticias: los tests nunca llaman a proveedores reales.
      miniflare: { bindings: { TMDB_API_URL: 'https://tmdb.test/3', TMDB_IMAGE_URL: 'https://img.test/t/p', PLAYER_BASE_URL: 'https://player.test' } },
    }),
  ],
});
