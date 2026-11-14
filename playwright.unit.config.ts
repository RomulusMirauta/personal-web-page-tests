import { defineConfig } from '@playwright/test';

/** Pure unit tests (no browser): helpers of the suite itself, such as the privacy pattern. */
export default defineConfig({
  testDir: 'unit',
  fullyParallel: true,
  reporter: [['list']],
});
