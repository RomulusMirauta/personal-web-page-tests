import type { Page } from '@playwright/test';
import { appPath, categoryIds, dispatch, openApp, screenOrder, trackErrors } from './support/app';
import { expect, test } from './support/test';

/**
 * Content-Security-Policy. Every page carries the policy twice: as a response header (the host sends
 * it) and as a <meta> (so a copy served by a host without headers is protected too). The tests read
 * the live policy and check its security properties, not its exact wording, then use the app under
 * it and expect no violation.
 */

/** The analytics the app is allowed to load: a page-view counter (script host and beacon host). */
const ALLOWED_THIRD_PARTY = [/^https:\/\/gc\.zgo\.at$/, /^https:\/\/([a-z0-9-]+|\*)\.goatcounter\.com$/];

type Policy = Map<string, string[]>;

function parse(policy: string): Policy {
  const map: Policy = new Map();
  for (const part of policy.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) map.set(name.toLowerCase(), values);
  }
  return map;
}

/** The security properties every page's policy must have, whichever way it is delivered. */
function expectStrict(policy: Policy, where: string): void {
  const directive = (name: string) => policy.get(name) ?? policy.get('default-src') ?? [];
  expect(policy.get('default-src'), `${where}: default-src`).toEqual(["'self'"]);
  expect(policy.get('object-src'), `${where}: object-src`).toEqual(["'none'"]);
  expect(policy.get('base-uri'), `${where}: base-uri`).toEqual(["'self'"]);
  // Forms may post nowhere, or only back to the app itself.
  expect(["'none'", "'self'"], `${where}: form-action ${policy.get('form-action')}`).toContain(policy.get('form-action')?.join(' '));
  for (const [name, values] of policy) {
    expect(values, `${where}: ${name} allows eval`).not.toContain("'unsafe-eval'");
    expect(values, `${where}: ${name} allows any host`).not.toContain('*');
    for (const v of values) {
      // Sources that are hosts (not keywords, schemes such as data:/blob:, nonces or hashes).
      if (v.startsWith("'") || /^[a-z]+:$/.test(v)) continue;
      expect(ALLOWED_THIRD_PARTY.some((re) => re.test(v)), `${where}: ${name} allows ${v}`).toBe(true);
    }
  }
  // Scripts and connections: same origin plus, at most, the allowed analytics hosts.
  for (const name of ['script-src', 'connect-src']) expect(directive(name), `${where}: ${name}`).toContain("'self'");
  expect(directive('script-src'), `${where}: script-src allows data: or blob: scripts`).not.toEqual(expect.arrayContaining(['data:']));
}

type Violations = { __csp: string[] };

/** Records securitypolicyviolation events in every document the page loads. */
async function recordViolations(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const list: string[] = [];
    (window as unknown as Violations).__csp = list;
    document.addEventListener('securitypolicyviolation', (e) => list.push(`${e.effectiveDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`));
  });
}

async function violations(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as Violations).__csp);
}

/** Every screen, a detail view of each wheel and the soft-skills wheel. */
async function walkTheApp(page: Page): Promise<void> {
  for (const screen of await screenOrder(page)) await dispatch(page, { t: 'tab/set', screen });
  await dispatch(page, { t: 'tab/set', screen: 'skills' });
  const [first] = await categoryIds(page, 'hard');
  await dispatch(page, { t: 'cat/open', cat: first }, { t: 'back' });
  await dispatch(page, { t: 'wheel/set', wheel: 'soft' });
  const [soft] = await categoryIds(page, 'soft');
  await dispatch(page, { t: 'cat/open', cat: soft }, { t: 'back' }, { t: 'wheel/set', wheel: 'hard' });
}

const decode = (s: string) => s.replaceAll('&#x27;', "'").replaceAll('&#39;', "'").replaceAll('&quot;', '"').replaceAll('&amp;', '&');

test.describe('Content-Security-Policy', { tag: '@all-devices' }, () => {
  test('every page sends a strict policy header and carries one in a <meta>, ahead of every inline script', async ({ request }) => {
    for (const path of [appPath(), '/cv/', '/this-page-does-not-exist/']) {
      const response = await request.get(path);
      const header = response.headers()['content-security-policy'];
      expect(header, `${path}: CSP header`).toBeTruthy();
      const fromHeader = parse(header);
      expectStrict(fromHeader, `${path} header`);
      // The header also forbids framing (a <meta> policy cannot).
      expect(fromHeader.get('frame-ancestors'), `${path}: frame-ancestors`).toEqual(["'none'"]);

      const html = await response.text();
      const metas = [...html.matchAll(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/gi)];
      expect(metas, `${path}: one CSP <meta>`).toHaveLength(1);
      expectStrict(parse(decode(metas[0][1])), `${path} <meta>`);
      // The parser applies a <meta> policy from where it stands: every inline script must come later.
      const inline = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>/g)].map((m) => m.index);
      if (inline.length) expect(Math.min(...inline), `${path}: first inline script after the <meta>`).toBeGreaterThan(metas[0].index);
    }
  });

  test('no violations while using the app and /cv/', { tag: '@critical' }, async ({ page }) => {
    await recordViolations(page);
    const errors = trackErrors(page);
    await openApp(page);
    await walkTheApp(page);
    expect(await violations(page)).toEqual([]);
    // The app's scripts ran under the policy.
    expect(await page.evaluate(() => typeof window.__site?.dispatch)).toBe('function');

    await page.goto('/cv/');
    await expect(page.locator('h1').first()).toBeVisible();
    expect(await violations(page)).toEqual([]);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('the policy refuses an image from another origin', async ({ page }) => {
    await openApp(page);
    const refused = await page.evaluate(
      () =>
        new Promise<string>((resolve) => {
          document.addEventListener('securitypolicyviolation', (e) => resolve(`${e.effectiveDirective} ${e.blockedURI}`), { once: true });
          const img = document.createElement('img');
          img.src = 'https://example.invalid/pixel.png';
          document.body.append(img);
        }),
    );
    expect(refused).toBe('img-src https://example.invalid/pixel.png');
  });

  test("the policy refuses eval in the page's own scripts", async ({ page }) => {
    // A probe script added to the served page, as if it were part of the app (headers kept as sent).
    // Code run from the test runner itself would not do: the browser exempts devtools-initiated
    // code from the page's policy.
    const probe = '<script>window.__evalProbe = (function () { try { return "ran " + eval("1 + 1"); } catch (e) { return e.name; } })();</script>';
    await page.route(
      (url) => url.pathname === '/cv/',
      async (route) => {
        const response = await route.fetch();
        await route.fulfill({ response, body: (await response.text()).replace('</body>', `${probe}</body>`) });
      },
    );
    await page.goto('/cv/');
    expect(await page.evaluate(() => (window as unknown as { __evalProbe?: string }).__evalProbe)).toBe('EvalError');
  });
});
