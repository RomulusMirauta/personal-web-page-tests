import { defineConfig, devices } from '@playwright/test';

/**
 * Black-box E2E suite for the portfolio app. It runs against a deployed URL (production by default):
 *
 *   BASE_URL=https://preview-xyz.vercel.app npx playwright test   # any deployment of the app
 *   npx playwright test --grep @smoke                              # the fast tier (every push / PR)
 *   npx playwright test --project=desktop-chromium                 # one device class
 *
 * Every page goes through the fixture in e2e/support/test.ts, which blocks the analytics hosts so a
 * test run never counts as a visit.
 */
const onCI = !!process.env.CI;
export const BASE_URL = (process.env.BASE_URL ?? 'https://romulus-mirauta.vercel.app').replace(/\/+$/, '');

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results',
  fullyParallel: true,
  // Locally: every CPU thread (Playwright's default is half). CI runners get their own value.
  workers: process.env.WORKERS ? Number(process.env.WORKERS) : onCI ? 4 : '100%',
  // A live URL means a real network and a CDN: CI retries a failure once and reports it as flaky
  // instead of hiding it. Locally a failure is a failure.
  retries: onCI ? 1 : 0,
  forbidOnly: onCI,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: onCI
    ? [['github'], ['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }], ['json', { outputFile: 'test-results/results.json' }]]
    : [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: BASE_URL,
    colorScheme: 'dark',
    locale: 'en-US',
    timezoneId: 'Europe/Bucharest',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop-chromium',
      // Phone-only tests (@mobile) run in the phone project only.
      grepInvert: /@mobile/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 },
    },
    {
      // A real phone browser, not a full-screen emulation: Chrome on a mid-range Android phone
      // leaves 411×776 CSS px for the page once its address and navigation bars are drawn.
      name: 'phone-chromium',
      // The phone tests, plus the device-independent checks (@all-devices) a second time.
      grep: /@mobile|@all-devices/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 411, height: 776 },
        deviceScaleFactor: 2.625,
        isMobile: true,
        hasTouch: true,
        userAgent: devices['Pixel 7'].userAgent,
      },
    },
  ],
});
