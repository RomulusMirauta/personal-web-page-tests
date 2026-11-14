import { openApp } from './support/app';
import { expect, newContext, test } from './support/test';

/** Pages in a PDF Chromium printed (its page objects). */
const pageCount = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;

/** The app itself does not print (it is a dark, animated stage): a short note points to the printable CV. */
test('printing the app gives one page with a note pointing to /cv/', async ({ page }) => {
  await openApp(page);
  await page.emulateMedia({ media: 'print' });
  const note = page.locator('[data-print-note]');
  await expect(note).toBeVisible();
  await expect(note.locator('a')).toHaveAttribute('href', /\/cv\/$/);
  // Black ink on paper.
  expect(await note.evaluate((e) => getComputedStyle(e).color)).toBe('rgb(0, 0, 0)');
  // Nothing else of the app prints: no stage, no background, no overlays.
  const others = await page.evaluate(() => {
    const n = document.querySelector('[data-print-note]')!;
    return [...document.body.querySelectorAll('*')].filter((e) => !n.contains(e) && !e.contains(n) && e.checkVisibility() && e.getBoundingClientRect().width > 0).length;
  });
  expect(others).toBe(0);
  expect(pageCount(await page.pdf({ format: 'A4' }))).toBe(1);
  // On screen the note stays hidden.
  await page.emulateMedia({ media: 'screen' });
  await expect(note).toBeHidden();
});

/** /cv/ as recruiters use it: printed to A4, and read on a phone. */
test.describe('/cv/ print and small screens', () => {
  test('prints in CV order to at most 4 A4 pages, names and levels only, in black', async ({ page }) => {
    await page.goto('/cv/');
    await page.emulateMedia({ media: 'print' });
    // The order a CV is read in: the summary first, experience before skills, projects before education.
    const ids = await page.locator('main h2').evaluateAll((hs) => hs.filter((h) => (h as HTMLElement).checkVisibility()).map((h) => h.id));
    expect(ids[0]).toBe('cv-about');
    expect(ids.indexOf('cv-experience')).toBeGreaterThan(0);
    expect(ids.indexOf('cv-experience')).toBeLessThan(ids.indexOf('cv-skills'));
    expect(ids.indexOf('cv-projects')).toBeLessThan(ids.indexOf('cv-education'));
    const pages = pageCount(await page.pdf({ format: 'A4', preferCSSPageSize: true }));
    expect(pages).toBeGreaterThan(0);
    expect(pages).toBeLessThanOrEqual(4);
    // Skill descriptions are left out of print: names and levels only.
    const prose = page.locator('main li[id] > p:not(:first-child)');
    expect(await prose.count()).toBeGreaterThan(0);
    for (const display of await prose.evaluateAll((els) => els.map((e) => getComputedStyle(e).display))) expect(display).toBe('none');
    const greys = await page.evaluate(() =>
      [...document.querySelectorAll('main *')].filter((e) => e.checkVisibility() && getComputedStyle(e).color !== 'rgb(0, 0, 0)').map((e) => e.tagName),
    );
    expect(greys, 'every printed element is black').toEqual([]);
    // External links print their address next to them (paper has no links).
    await expect(page.locator('main a[href^="http"] + span').first()).toBeVisible();
  });

  for (const width of [320, 390]) {
    test(`does not scroll sideways at ${width} px`, async ({ browser }) => {
      const ctx = await newContext(browser, { viewport: { width, height: 800 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      try {
        const page = await ctx.newPage();
        await page.goto('/cv/');
        const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
        expect(scroll).toBeLessThanOrEqual(client);
      } finally {
        await ctx.close();
      }
    });
  }
});
