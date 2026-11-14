import type { Page } from '@playwright/test';
import { appPath, openApp } from './support/app';
import { axeViews, finishAnimations, openDisplayOptions, seriousFindings, showView } from './support/axe';
import { expect, test } from './support/test';

/**
 * The axe matrix: the scan of a11y.spec.ts (WCAG 2.2 AA tags, no serious or critical finding) in the
 * combinations that spec leaves out. a11y.spec.ts covers dark theme, keys on, 1920×1080; this adds
 *   1920×1080            every view and the open Display options in the other three theme × keys
 *                        combinations (keys: the single-key shortcuts and their on-screen key hints);
 *                        the intro and /cv/ in the light theme
 *   1366×768, 1280×720   every view, each size in two of the four theme × keys combinations, crossed
 *                        so that every pairing of size, theme and key mode is scanned
 * One test per combination, so a failure names its combination.
 */
test.describe.configure({ mode: 'parallel' });

/**
 * localStorage key under which the app keeps the visitor's shortcuts choice (the K switch, also in
 * Display options). Read from the live app: pressing K stores "off" under it.
 */
const SHORTCUTS_KEY = 'shortcuts';

interface Combo {
  theme: 'dark' | 'light';
  keys: 'on' | 'off';
}
interface Size {
  width: number;
  height: number;
}

const DESKTOP: Size = { width: 1920, height: 1080 };
const DESKTOP_COMBOS: readonly Combo[] = [
  { theme: 'dark', keys: 'off' },
  { theme: 'light', keys: 'on' },
  { theme: 'light', keys: 'off' },
];
const LAPTOPS: readonly { size: Size; combos: readonly Combo[] }[] = [
  { size: { width: 1366, height: 768 }, combos: [{ theme: 'dark', keys: 'on' }, { theme: 'light', keys: 'off' }] },
  { size: { width: 1280, height: 720 }, combos: [{ theme: 'dark', keys: 'off' }, { theme: 'light', keys: 'on' }] },
];

const named = ({ theme, keys }: Combo, { width, height }: Size) => `${theme} theme, keys ${keys}, ${width}×${height}`;

/** The app in a theme (URL flag) with the shortcuts on or off (the stored choice, as K leaves it). */
async function openIn(page: Page, { theme, keys }: Combo): Promise<void> {
  if (keys === 'off') {
    await page.addInitScript((key) => {
      try {
        localStorage.setItem(key, 'off');
      } catch {
        // Storage blocked: the data-shortcuts check below fails the test.
      }
    }, SHORTCUTS_KEY);
  }
  await openApp(page, { theme });
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await expect(page.locator('html')).toHaveAttribute('data-shortcuts', keys);
}

async function expectClean(page: Page): Promise<void> {
  const found = await seriousFindings(page);
  expect(found, found.join('\n')).toEqual([]);
}

/** Every view of the live app (read from its header), one step each. */
async function scanEveryView(page: Page, combo: Combo): Promise<void> {
  test.slow();
  await openIn(page, combo);
  const views = await axeViews(page);
  for (const view of views) {
    await test.step(view.name, async () => {
      await openIn(page, combo);
      await showView(page, view);
      await expectClean(page);
    });
  }
}

test.describe('axe matrix', { tag: '@a11y' }, () => {
  for (const combo of DESKTOP_COMBOS) {
    test.describe(named(combo, DESKTOP), () => {
      test('every view', async ({ page }) => {
        await scanEveryView(page, combo);
      });

      test('display options open', async ({ page }) => {
        await openIn(page, combo);
        await openDisplayOptions(page);
        await expectClean(page);
      });
    });
  }

  test.describe('light theme, 1920×1080', () => {
    test('intro overlay', async ({ page }) => {
      await page.goto(appPath({ intro: null, theme: 'light' }));
      await page.waitForFunction(() => Boolean(window.__site));
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
      await expect(page.locator('html')).toHaveAttribute('data-intro', 'play');
      await finishAnimations(page); // the intro's text fades in: scan it fully shown
      await expectClean(page);
    });

    test('recruiter view /cv/', async ({ page }) => {
      await page.goto('/cv/?theme=light');
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
      await expectClean(page);
    });
  });

  for (const { size, combos } of LAPTOPS) {
    for (const combo of combos) {
      test.describe(named(combo, size), () => {
        test.use({ viewport: size });

        test('every view', async ({ page }) => {
          await scanEveryView(page, combo);
        });
      });
    }
  }
});
