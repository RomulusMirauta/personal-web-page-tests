import { appPath, openApp } from './support/app';
import { axeViews, finishAnimations, openDisplayOptions, seriousFindings, showView } from './support/axe';
import { expect, test } from './support/test';

/**
 * axe (WCAG 2.2 AA tags) in the default combination: dark theme, single-key shortcuts on, 1920×1080.
 * Every view the header leads to, the wheel's hover and detail views, the open Display options, the
 * intro and the printable /cv/ page. a11y-matrix.spec.ts scans the other themes, key modes and sizes.
 */
test.describe('axe: no serious or critical findings', { tag: '@a11y' }, () => {
  test('skills wheel', { tag: '@smoke' }, async ({ page }) => {
    await openApp(page);
    const [wheel] = await axeViews(page);
    await showView(page, wheel);
    const found = await seriousFindings(page);
    expect(found, found.join('\n')).toEqual([]);
  });

  // The views are read from the live app (its header and categories), so they are not known when the
  // tests are collected: one test, a step per view (a failure names its view).
  test('every other view', async ({ page }) => {
    await openApp(page);
    const views = (await axeViews(page)).slice(1);
    expect(views.length).toBeGreaterThan(0);
    for (const view of views) {
      await test.step(view.name, async () => {
        await openApp(page);
        await showView(page, view);
        const found = await seriousFindings(page);
        expect(found, `${view.name}:\n${found.join('\n')}`).toEqual([]);
      });
    }
  });

  test('display options open', async ({ page }) => {
    await openApp(page);
    await openDisplayOptions(page);
    const found = await seriousFindings(page);
    expect(found, found.join('\n')).toEqual([]);
  });

  test('intro overlay', async ({ page }) => {
    await page.goto(appPath({ intro: null }));
    await page.waitForFunction(() => Boolean(window.__site));
    await expect(page.locator('html')).toHaveAttribute('data-intro', 'play');
    await finishAnimations(page); // the intro's text fades in: scan it fully shown
    const found = await seriousFindings(page);
    expect(found, found.join('\n')).toEqual([]);
  });

  test('recruiter view /cv/', async ({ page }) => {
    await page.goto('/cv/');
    const found = await seriousFindings(page);
    expect(found, found.join('\n')).toEqual([]);
  });
});
