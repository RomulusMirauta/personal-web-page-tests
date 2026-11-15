import type { Page } from '@playwright/test';
import { appPath, dispatch, openApp, screenOrder, sectionNames, settle, ui } from './support/app';
import { expect, test } from './support/test';

/**
 * Naming. Labels the header and footer show in capitals are written in sentence case in the DOM and
 * in their accessible names; the capitals come from CSS, so the look does not change. (Chromium's
 * own accessibility tree applies text-transform to names computed from shown text, so the HUD's
 * controls take their names from visually hidden text in sentence case.) And the product is called
 * an app throughout: the intro, /cv/ and the contact card.
 */

/** Header and footer of the stage: where labels are shown in capitals. */
const HUD = 'header[data-hud], footer[data-hud]';

/** A word of three or more capitals in an accessible name (two-letter acronyms such as QA are fine). */
const SHOUTED = /\b[A-Z]{3,}\b/;

const exact = (s: string) => new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);

/**
 * Writes every text the HUD shows through `text-transform: uppercase` in capitals in the DOM;
 * returns how many text nodes changed.
 */
async function writeCapitals(page: Page): Promise<number> {
  return page.evaluate((selector) => {
    let changed = 0;
    for (const root of document.querySelectorAll(selector)) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let t = walker.nextNode(); t; t = walker.nextNode()) {
        const el = t.parentElement;
        if (!el || getComputedStyle(el).textTransform !== 'uppercase') continue;
        const caps = t.nodeValue!.toUpperCase();
        if (caps === t.nodeValue) continue;
        t.nodeValue = caps;
        changed++;
      }
    }
    return changed;
  }, HUD);
}

/**
 * The stage looks the same with sentence case in the DOM as with the capitals written out. The
 * comparison starts from a settled shot: two in a row alike (a late image may still be decoding).
 */
async function expectCapitalsByCss(page: Page, what: string): Promise<void> {
  await settle(page);
  await page.waitForLoadState('networkidle');
  const shot = () => page.screenshot({ animations: 'disabled', caret: 'hide' });
  let css = await shot();
  for (let i = 0; ; i++) {
    const again = await shot();
    if (Buffer.compare(css, again) === 0) break;
    expect(i, `${what}: the stage settles`).toBeLessThan(10);
    css = again;
  }
  expect(await writeCapitals(page), `${what}: sentence case under text-transform`).toBeGreaterThan(0);
  const written = await shot();
  expect(Buffer.compare(css, written), `${what}: pixel-identical with the capitals written out`).toBe(0);
}

async function hudSnapshot(page: Page): Promise<string> {
  const parts = await Promise.all([ui.sections(page).ariaSnapshot(), ui.hud(page).ariaSnapshot()]);
  return parts.join('\n');
}

/** The header's expected names on a screen, from the section names in header order. */
function headerNames(names: string[], i: number) {
  const n = names.length;
  return { title: names[i], prev: `Previous section: ${names[(i - 1 + n) % n]}`, next: `Next section: ${names[(i + 1) % n]}` };
}

test.describe('naming', { tag: '@a11y' }, () => {
  test('accessible names are not in capitals; the look is unchanged', async ({ page }) => {
    await openApp(page);
    const screens = await screenOrder(page);
    const names = await sectionNames(page);
    const start = screens.indexOf('skills');
    await settle(page);
    const hub = headerNames(names, start);
    await expect(ui.sectionTitle(page)).toHaveAccessibleName(hub.title);
    await expect(ui.prevSection(page)).toHaveAccessibleName(hub.prev);
    await expect(ui.nextSection(page)).toHaveAccessibleName(hub.next);
    for (const name of names) expect(name, 'section names are in sentence case').not.toMatch(SHOUTED);
    // The dots are named by their tooltips alone (an aria-label repeating the title would be read twice).
    const dots = ui.header(page).locator('ol li button');
    for (const [i, name] of names.entries()) await expect(dots.nth(i)).toHaveAccessibleName(name);
    // The footer: the wheel switch and the call to action.
    await expect(ui.softSkills(page)).toBeVisible();
    const cta = page.locator('footer[data-hud] a[data-cta]');
    await expect(cta).toBeVisible();
    await expect(cta).toHaveAccessibleName(/book a call/i);
    expect(await hudSnapshot(page)).not.toMatch(SHOUTED);
    // Shown in capitals all the same.
    await expect(ui.sectionTitle(page)).toHaveCSS('text-transform', 'uppercase');
    await expectCapitalsByCss(page, 'skills wheel');

    // The call to action unfolds its prefix while hovered.
    await openApp(page);
    await cta.hover();
    await expectCapitalsByCss(page, 'skills wheel, call to action unfolded');

    await openApp(page);
    await dispatch(page, { t: 'wheel/toggle' });
    await expect(page.getByRole('button', { name: /^hard skills$/i })).toBeVisible();
    expect(await hudSnapshot(page)).not.toMatch(SHOUTED);
    await expectCapitalsByCss(page, 'soft skills wheel');

    // Another screen: the one before Skills in the header.
    await openApp(page);
    const other = (start - 1 + screens.length) % screens.length;
    await dispatch(page, { t: 'tab/set', screen: screens[other] });
    const there = headerNames(names, other);
    await expect(ui.sectionTitle(page)).toHaveAccessibleName(there.title);
    await expect(ui.prevSection(page)).toHaveAccessibleName(there.prev);
    await expect(ui.nextSection(page)).toHaveAccessibleName(there.next);
    expect(await hudSnapshot(page)).not.toMatch(SHOUTED);
    await expectCapitalsByCss(page, `${screens[other]} screen`);
  });

  test("Chromium's accessibility tree names the HUD controls in sentence case, keyboard hints on and off", async ({ page }) => {
    for (const keys of ['on', 'off'] as const) {
      await openApp(page);
      const screens = await screenOrder(page);
      const names = await sectionNames(page);
      const start = screens.indexOf('skills');
      await page.evaluate((k) => (document.documentElement.dataset.shortcuts = k), keys);
      await settle(page);
      const hubNames = await chromiumNames(page);
      const hub = headerNames(names, start);
      for (const name of [hub.prev, hub.next]) expect(hubNames, `keys ${keys}, skills wheel`).toContain(name);
      expect(hubNames, `keys ${keys}, skills wheel`).toContainEqual(expect.stringMatching(/^soft skills$/i));
      expect(hubNames, `keys ${keys}, skills wheel`).toContainEqual(expect.stringMatching(/book a call/i));
      expect(hubNames.filter((n) => SHOUTED.test(n)), `keys ${keys}, skills wheel: names in capitals`).toEqual([]);

      await dispatch(page, { t: 'wheel/toggle' });
      const soft = await chromiumNames(page);
      expect(soft, `keys ${keys}, soft skills wheel`).toContainEqual(expect.stringMatching(/^hard skills$/i));
      expect(soft.filter((n) => SHOUTED.test(n)), `keys ${keys}, soft skills wheel: names in capitals`).toEqual([]);

      const other = (start - 1 + screens.length) % screens.length;
      await dispatch(page, { t: 'wheel/toggle' }, { t: 'tab/set', screen: screens[other] });
      const there = headerNames(names, other);
      const otherNames = await chromiumNames(page);
      for (const name of [there.prev, there.next]) expect(otherNames, `keys ${keys}, ${screens[other]}`).toContain(name);
      expect(otherNames.filter((n) => SHOUTED.test(n)), `keys ${keys}, ${screens[other]}: names in capitals`).toEqual([]);
    }
  });

  test('it is called an app: the intro, /cv/ and the contact card', async ({ page, request }) => {
    // The intro dialog is in the prerendered page: hold the scripts so it stays up to be read.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route('**/_next/static/chunks/**', async (route) => {
      await held;
      await route.continue();
    });
    try {
      await page.goto(appPath({ intro: null }), { waitUntil: 'commit' });
      await expect(page.getByRole('dialog')).toHaveAccessibleName(/\bapp\b/i);
      await expect(page.getByRole('dialog')).not.toHaveAccessibleName(/\b(web)?site\b/i);
    } finally {
      release();
    }

    await page.goto('/cv/');
    // "<name> — <job title> · CV": the owner and the role first, what the page is last.
    await expect(page).toHaveTitle(/^\S.* — \S.* · CV$/);
    const title = await page.title();
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', exact(title));
    await expect(page.locator('meta[name="twitter:title"]')).toHaveAttribute('content', exact(title));
    const top = page.getByRole('navigation', { name: /^app$/i });
    await expect(top.getByRole('link', { name: /^back to the app$/i })).toBeVisible();
    await expect(page.getByRole('contentinfo').getByRole('link', { name: /^back to the app$/i })).toBeVisible();

    const cards = await page.locator('a[href$=".vcf"]').evaluateAll((as) => [...new Set(as.map((a) => (a as HTMLAnchorElement).href))]);
    expect(cards.length, '/cv/ links the contact card').toBeGreaterThan(0);
    for (const href of cards) {
      const vcard = await (await request.get(href)).text();
      expect(vcard).toMatch(/\r\nPRODID:[^\r\n]*\bApp\b[^\r\n]*\r\n/);
      expect(vcard).not.toMatch(/^PRODID:[^\r\n]*\bsite\b/im);
    }
  });
});

/**
 * Chromium's own names (CDP) for the HUD controls shown in capitals that are in its tree: the
 * header's buttons, the wheel switch and the call to action.
 */
async function chromiumNames(page: Page): Promise<string[]> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
    const { nodeIds } = await cdp.send('DOM.querySelectorAll', {
      nodeId: root.nodeId,
      selector: 'header[data-hud] button, footer[data-hud] > button, footer[data-hud] a[data-cta]',
    });
    const names: string[] = [];
    for (const nodeId of nodeIds) {
      const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
      if (!nodes[0].ignored) names.push(String(nodes[0].name?.value ?? ''));
    }
    return names;
  } finally {
    await cdp.detach();
  }
}
