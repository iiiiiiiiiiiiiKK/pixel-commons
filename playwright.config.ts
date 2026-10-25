import { defineConfig, devices } from '@playwright/test';

/**
 * Browser end-to-end suite.
 *
 * Runs against a live deployment (default: the public Pages URL) so it exercises
 * the real Worker + Durable Object, not a mock:
 *
 *   npx playwright test                       # against the deployed site
 *   PIXEL_COMMONS_URL=http://127.0.0.1:8787 npx playwright test   # local
 *
 * Two projects are configured on purpose: desktop Chromium and a real iPhone 13
 * device profile, so responsive/touch behaviour is verified instead of assumed.
 */
const baseURL = process.env.PIXEL_COMMONS_URL || 'https://pixel-commons.pages.dev';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 90_000,
  expect: { timeout: 25_000 },
  fullyParallel: false,
  workers: 1,
  retries: 1,
  reporter: [['list']],
  use: {
    baseURL,
    ignoreHTTPSErrors: true,
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
  projects: [
    {
      name: 'desktop-chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'iphone-13',
      use: { ...devices['iPhone 13'] },
    },
  ],
});
