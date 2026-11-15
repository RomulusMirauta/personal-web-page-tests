import type { Page } from '@playwright/test';
import { appState, dispatch, openApp, screenOrder, sectionNames, settle, ui } from './support/app';
import { expect, test } from './support/test';

/**
 * The Contact and Education sections. Contact gathers every way to reach the owner (email, LinkedIn,
 * the CV, the contact card, the printable CV) under an "Open to work" status whose lit dot is never
 * clipped, and says how visits are counted. Education puts schools, jobs and the gaps between jobs
 * on one timeline, with an at-a-glance chart that says the same in words; Experience shows the work
 * history only. On a phone the band shows a short form of a long section name; its name stays whole.
 */

/** Show a section and wait until its entries have slid in (CSS). */
async function show(page: Page, screen: string): Promise<void> {
  await dispatch(page, { t: 'tab/set', screen });
  await settle(page);
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity));
}

const contact = (page: Page) => ui.screen(page, /^contact$/i);
const education = (page: Page) => ui.screen(page, /^education$/i);

test.describe('Contact and Education sections', () => {
  test('both are sections of their own: a header dot, a route and a named region each', { tag: '@critical' }, async ({ page }) => {
    await openApp(page);
    const names = await sectionNames(page);
    const screens = await screenOrder(page);
    for (const [screen, name] of [
      ['contact', /^contact$/i],
      ['education', /^education$/i],
    ] as const) {
      const i = screens.indexOf(screen);
      expect(i, `${screen} is a section`).toBeGreaterThanOrEqual(0);
      expect(names[i]).toMatch(name);
      await page.evaluate((s) => (location.hash = `#/${s}`), screen);
      await expect.poll(async () => (await appState(page)).screen).toBe(screen);
      await expect(ui.screen(page, name)).toBeVisible();
      await expect(ui.sectionTitle(page)).toHaveAccessibleName(name);
    }
  });

  test('Contact: email, LinkedIn, the CV, the contact card and the printable CV; how visits are counted', { tag: '@critical' }, async ({ page }) => {
    await openApp(page);
    await show(page, 'contact');
    const region = contact(page);
    await expect(region.locator('a[href^="mailto:"]').first()).toBeVisible();
    const linkedin = region.locator('a[href*="linkedin.com/"]').first();
    await expect(linkedin).toHaveAttribute('target', '_blank');
    await expect(linkedin).toHaveAccessibleName(/\(opens in a new tab\)$/);
    // The CV and contact card row.
    await expect(region.getByRole('link', { name: 'Download CV' })).toHaveAttribute('href', /\.pdf$/);
    await expect(region.locator('a[href$=".vcf"]')).toHaveAttribute('download', '');
    await expect(region.getByRole('link', { name: /printable cv/i })).toHaveAttribute('href', /\/cv\/$/);
    // The analytics notice: cookieless counting, said where the visitor can read it.
    await expect(region.locator('[data-privacy]')).toContainText(/no cookies/i);
  });

  for (const [w, h] of [
    [1920, 1080],
    [1366, 768],
  ] as const) {
    test(`Contact: the "Open to work" status dot and its full halo stay inside the visible area (${w}×${h})`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await openApp(page);
      await show(page, 'contact');
      await expectStatusDotInside(page);
    });
  }

  test('phone: the "Open to work" status dot and its full halo stay inside the visible area', { tag: '@mobile' }, async ({ page }) => {
    await openApp(page);
    await show(page, 'contact');
    await expectStatusDotInside(page);
  });

  test('Education: one timeline of schools, jobs and gaps; a chart that says it in words; Experience keeps the work only', { tag: '@critical' }, async ({ page }) => {
    await openApp(page);
    await show(page, 'education');
    const region = education(page);
    const chart = region.getByRole('img').first();
    await expect(chart).toHaveAccessibleName(/^Timeline from \d{4} to today: .*(schools?|courses?).*jobs?/i);
    const kinds = await region.locator('li[data-kind]').evaluateAll((lis) => lis.map((li) => li.getAttribute('data-kind')));
    expect(new Set(kinds), 'schools and jobs on one timeline').toEqual(new Set(kinds.filter((k) => k === 'education' || k === 'work' || k === 'gap')));
    expect(kinds).toContain('education');
    expect(kinds).toContain('work');
    const name = (await chart.getAttribute('aria-label')) ?? '';
    // A gap between jobs on the timeline is named in the chart's words too, and the other way round.
    if (kinds.includes('gap')) expect(name).toMatch(/\bgaps? between jobs\b/i);
    else expect(name).toMatch(/no gaps between jobs/i);

    await show(page, 'experience');
    const experience = await ui.screen(page, /^experience$/i).locator('li[data-kind]').evaluateAll((lis) => lis.map((li) => li.getAttribute('data-kind')));
    expect(experience.length).toBeGreaterThan(0);
    expect(new Set(experience), 'Experience lists roles only').toEqual(new Set(['role']));
  });

  test('phone: the band shows a short form of a long section name, the name itself stays whole', { tag: '@mobile' }, async ({ page }) => {
    await openApp(page);
    await show(page, 'education');
    const title = ui.sectionTitle(page);
    await expect(title).toHaveAccessibleName(/^education$/i);
    const shown = await title.evaluate((h2) =>
      [...h2.querySelectorAll<HTMLElement>(':scope > span')]
        .filter((el) => el.getBoundingClientRect().width > 1 && getComputedStyle(el).display !== 'none')
        .map((el) => el.innerText.trim())
        .filter(Boolean),
    );
    expect(shown, 'one form shown').toHaveLength(1);
    expect(shown[0].length, `"${shown[0]}" is shorter than the name`).toBeLessThan('education'.length);
    expect('EDUCATION'.startsWith(shown[0].toUpperCase()), `"${shown[0]}" abbreviates the name`).toBe(true);
    // The neighbour's button keeps the whole name too.
    await show(page, 'experience');
    await expect(ui.nextSection(page)).toHaveAccessibleName(/^next section: education$/i);
  });

  test('desktop: the band shows the whole section name', async ({ page }) => {
    await openApp(page);
    await show(page, 'education');
    const shown = await ui.sectionTitle(page).evaluate((h2) => (h2 as HTMLElement).innerText.trim());
    expect(shown.toUpperCase()).toBe('EDUCATION');
  });
});

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * The status dot's painted extent (the dot plus its box-shadow halo, at the largest any animation on
 * it reaches) lies inside every clipping ancestor, the viewport, and clear of the scroll area's top fade.
 */
async function expectStatusDotInside(page: Page): Promise<void> {
  const r = await page.evaluate(() => {
    const dot = document.querySelector<HTMLElement>('section[aria-label="Contact"] [aria-labelledby] p > span[aria-hidden="true"]');
    if (!dot) return null;
    const px = (v: string) => Number.parseFloat(v) || 0;
    /** The dot's painted box now: its border box grown by every box shadow (offset, blur, spread). */
    const painted = () => {
      const b = dot.getBoundingClientRect();
      // Shadow lengths are local CSS px; the stage may scale the screen (client px per local px).
      const k = dot.offsetWidth > 0 ? b.width / dot.offsetWidth : 1;
      const out = { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
      const shadow = getComputedStyle(dot).boxShadow;
      if (shadow && shadow !== 'none') {
        for (const part of shadow.split(/,(?![^(]*\))/)) {
          if (/\binset\b/.test(part)) continue;
          const [x = 0, y = 0, blur = 0, spread = 0] = (part.match(/-?[\d.]+px/g) ?? []).map((v) => px(v) * k);
          out.left = Math.min(out.left, b.left + x - blur - spread);
          out.right = Math.max(out.right, b.right + x + blur + spread);
          out.top = Math.min(out.top, b.top + y - blur - spread);
          out.bottom = Math.max(out.bottom, b.bottom + y + blur + spread);
        }
      }
      return out;
    };
    // A pulse (any animation on the dot) sampled across one iteration: the union.
    let ext = painted();
    for (const a of dot.getAnimations()) {
      const d = Number(a.effect?.getTiming().duration) || 0;
      a.pause();
      for (let i = 0; i <= 40; i++) {
        a.currentTime = (d * i) / 40;
        const p = painted();
        ext = { left: Math.min(ext.left, p.left), top: Math.min(ext.top, p.top), right: Math.max(ext.right, p.right), bottom: Math.max(ext.bottom, p.bottom) };
      }
      a.play();
    }
    // What can show it: every ancestor that clips (overflow other than visible), and the viewport.
    let clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    let clippers = 0;
    for (let el = dot.parentElement; el; el = el.parentElement) {
      const cs = getComputedStyle(el);
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
      const b = el.getBoundingClientRect();
      clip = {
        left: Math.max(clip.left, b.left + el.clientLeft),
        top: Math.max(clip.top, b.top + el.clientTop),
        right: Math.min(clip.right, b.left + el.clientLeft + el.clientWidth),
        bottom: Math.min(clip.bottom, b.top + el.clientTop + el.clientHeight),
      };
      clippers++;
    }
    // The scroll area fades its top edge while it hides more above: the dot stays clear of it.
    const area = dot.closest<HTMLElement>('[data-scroll]')!;
    const fade = area.hasAttribute('data-more-above') ? px(getComputedStyle(area).getPropertyValue('--fade-top')) : 0;
    return { ext, clip, fade, areaTop: area.getBoundingClientRect().top, clippers };
  });
  expect(r, 'the status dot is on the Contact screen').not.toBeNull();
  const { ext, clip } = r as { ext: Box; clip: Box };
  expect(r!.clippers, 'the dot sits in a scroll area').toBeGreaterThan(0);
  expect(ext.right - ext.left, 'the halo is wider than nothing').toBeGreaterThan(4);
  expect(ext.left, 'left edge of the halo').toBeGreaterThanOrEqual(clip.left - 0.5);
  expect(ext.top, 'top edge of the halo').toBeGreaterThanOrEqual(clip.top - 0.5);
  expect(ext.right, 'right edge of the halo').toBeLessThanOrEqual(clip.right + 0.5);
  expect(ext.bottom, 'bottom edge of the halo').toBeLessThanOrEqual(clip.bottom + 0.5);
  expect(ext.top, 'clear of the top fade').toBeGreaterThanOrEqual(r!.areaTop + r!.fade - 0.5);
}
