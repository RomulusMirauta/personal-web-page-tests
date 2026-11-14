import type { Page } from '@playwright/test';
import { dispatch, openApp, screenOrder, settle } from './support/app';
import { INTL_PHONE_RE, PHONE_RE } from './support/privacy';
import { expect, test } from './support/test';

/**
 * Privacy: the public pages never publish a phone number, in any spelling, anywhere a visitor or a
 * crawler can read it: the visible text, the HTML, the structured data (JSON-LD) and the contact
 * card (vCard) the pages link to.
 */

const PATTERNS = [
  ['a Romanian phone number', PHONE_RE],
  ['an international phone number', INTL_PHONE_RE],
] as const;

/** Every phone-like match in a text, with a little context for the report. */
function phoneMatches(where: string, text: string): string[] {
  const found: string[] = [];
  for (const [what, re] of PATTERNS) {
    const g = new RegExp(re.source, `${re.flags.replace('g', '')}g`);
    for (const m of text.matchAll(g)) found.push(`${where}: ${what} near "${text.slice(Math.max(0, m.index - 20), m.index + m[0].length + 20)}"`);
  }
  return found;
}

async function jsonLd(page: Page): Promise<string> {
  return (await page.locator('script[type="application/ld+json"]').allTextContents()).join('\n');
}

async function visibleText(page: Page): Promise<string> {
  return page.evaluate(() => document.body.innerText);
}

test.describe('privacy: no phone number on the public pages', { tag: ['@all-devices', '@critical'] }, () => {
  test('the app: HTML, JSON-LD and the visible text of every screen', async ({ page }) => {
    await openApp(page);
    await settle(page);
    const found = [...phoneMatches('/ HTML', await page.content()), ...phoneMatches('/ JSON-LD', await jsonLd(page))];
    for (const screen of await screenOrder(page)) {
      await dispatch(page, { t: 'tab/set', screen });
      await settle(page);
      found.push(...phoneMatches(`#/${screen} text`, await visibleText(page)), ...phoneMatches(`#/${screen} HTML`, await page.content()));
    }
    expect(found, found.join('\n')).toEqual([]);
  });

  test('the server-rendered HTML of / and /cv/', async ({ request }) => {
    const found: string[] = [];
    for (const path of ['/', '/cv/']) {
      const response = await request.get(path);
      expect(response.status(), path).toBe(200);
      found.push(...phoneMatches(`${path} (as served)`, await response.text()));
    }
    expect(found, found.join('\n')).toEqual([]);
  });

  test('/cv/: visible text, JSON-LD and the linked vCard', async ({ page, request }) => {
    await page.goto('/cv/');
    const found = [
      ...phoneMatches('/cv/ text', await visibleText(page)),
      ...phoneMatches('/cv/ HTML', await page.content()),
      ...phoneMatches('/cv/ JSON-LD', await jsonLd(page)),
    ];
    const cards = await page.locator('a[href$=".vcf"]').evaluateAll((as) => [...new Set(as.map((a) => (a as HTMLAnchorElement).href))]);
    for (const href of cards) {
      const response = await request.get(href);
      expect(response.status(), href).toBe(200);
      const card = await response.text();
      expect(card, `${href} is a vCard`).toMatch(/^BEGIN:VCARD/);
      expect(card, `${href} has no TEL property`).not.toMatch(/^TEL[;:]/im);
      found.push(...phoneMatches(href, card));
    }
    expect(found, found.join('\n')).toEqual([]);
  });
});
