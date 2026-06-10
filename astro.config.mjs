// @ts-check
import { defineConfig } from 'astro/config';

import cloudflare from '@astrojs/cloudflare';

// https://astro.build/config
export default defineConfig({
  output: 'server',
  adapter: cloudflare(),
  vite: {
    optimizeDeps: {
      exclude: ['exceljs', 'jszip']
    },
    ssr: {
      external: ['better-sqlite3', '@libsql/client'],
      noExternal: ['exceljs', 'jszip'],
    }
  }
});