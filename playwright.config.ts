import { defineConfig } from '@playwright/test';

// BASE_URL=https://rasemottes.cyber-dodo.fr npm run e2e  -> teste la production
const external = !!process.env.BASE_URL;
const PORT = 3456;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  workers: 1,
  use: {
    baseURL: process.env.BASE_URL ?? `http://127.0.0.1:${PORT}`,
    launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
  },
  webServer: external
    ? undefined
    : {
        command: `node dist/server.mjs`,
        url: `http://127.0.0.1:${PORT}/healthz`,
        env: { PORT: String(PORT), DATA_DIR: 'test-results/data', SCORE_SECRET: 'e2e-secret' },
        reuseExistingServer: false,
        timeout: 30_000,
      },
});
