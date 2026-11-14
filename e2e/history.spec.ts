import { appState, categories, expectHashSettles, keysInOneTask, openApp } from './support/app';
import { expect, test } from './support/test';

/**
 * The URL always ends up describing the state, against the real framework router (which patches
 * pushState/replaceState) and real history traversals: races a unit test cannot show. "Ends up":
 * the hash settles on the expected value (expectHashSettles waits out any deferred write, router
 * re-apply and repair) instead of being read once after a fixed delay.
 */
test.describe('URL and state agree', { tag: '@critical' }, () => {
  test('a push followed at once by a replace is not reverted by the router (1 then E)', async ({ page }) => {
    await openApp(page);
    const cats = await categories(page);
    // Same-task input: the digit opens the first category, E moves straight on to the next one.
    await keysInOneTask(page, ['1', 'e']);
    const s = await appState(page);
    expect(s.mode).toEqual({ kind: 'detail', cat: cats[1].id, node: cats[1].node });
    await expectHashSettles(page, `#/skills/${cats[1].id}/${cats[1].node}`);
    expect(await page.evaluate(() => (history.state as { detail?: boolean } | null)?.detail)).toBe(true);
  });

  test('Esc then a digit while back() is in flight: Back still closes the detail view', async ({ page }) => {
    await openApp(page);
    const cats = await categories(page);
    await page.keyboard.press('1');
    // The pushed entry has landed and settled, so Esc goes back() instead of joining a deferred write.
    await expectHashSettles(page, `#/skills/${cats[0].id}/${cats[0].node}`);
    await keysInOneTask(page, ['Escape', '2']);
    await expectHashSettles(page, `#/skills/${cats[1].id}/${cats[1].node}`);
    await page.goBack();
    await expect.poll(async () => (await appState(page)).mode.kind).toBe('idle');
    expect(page.url()).not.toBe('about:blank');
  });

  test('a typed hash with an unknown, partial or encoded id is rewritten to the resolved view', async ({ page }) => {
    await openApp(page);
    const [cat] = await categories(page);
    const resolved = `#/skills/${cat.id}/${cat.node}`;
    await page.evaluate((id) => (location.hash = `#/skills/${id}/no-such-node`), cat.id);
    await expectHashSettles(page, resolved, 'an unknown node id is rewritten');
    const encoded = cat.id.replace(/^./, (ch) => `%${ch.charCodeAt(0).toString(16)}`);
    await page.evaluate((h) => (location.hash = h), `#/skills/${encoded}`);
    await expectHashSettles(page, resolved, 'a partial, %-encoded hash is rewritten');
    await page.evaluate(() => (location.hash = '#/foo'));
    await expectHashSettles(page, resolved, 'an unknown route keeps the view and its URL');
  });
});
