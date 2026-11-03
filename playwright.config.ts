import { defineConfig, devices } from '@playwright/test'

// The Worker, Durable Objects and D1 run locally under `alchemy dev`. The
// agent reaches a stand-in for OpenRouter (tests/browser/openrouter.ts), so
// no Cloudflare account or model costs are involved.
export default defineConfig({
  testDir: './tests/browser',
  globalSetup: './tests/browser/global-setup.ts',
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  // Engraving a page can take a few seconds on shared CI runners.
  expect: { timeout: 15_000 },
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:1337/',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npx alchemy dev',
    url: 'http://localhost:1337/',
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
    env: {
      OPENROUTER_URL: 'http://127.0.0.1:8788/api/v1',
      EMAIL_FROM: 'signin@example.com',
      KEY_ENCRYPTION_SECRET: 'local-test-secret',
    },
  },
})
