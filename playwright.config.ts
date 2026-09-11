import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: 'http://127.0.0.1:4173/score-chat/',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command:
      'npm run preview -- --host 127.0.0.1 --port 4173 --base /score-chat/',
    url: 'http://127.0.0.1:4173/score-chat/',
    reuseExistingServer: !process.env.CI,
  },
})
