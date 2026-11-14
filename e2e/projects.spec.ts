import { dispatch, openApp, ui } from './support/app';
import { expect, test } from './support/test';

/**
 * The Projects screen: featured project cards, each with a title and its links, the list of further
 * projects, and the card about this app itself, which leads to the QA Lab. The checks hold whatever
 * projects the content lists: no counts or titles are pinned.
 */
test.describe('Projects screen', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
    await dispatch(page, { t: 'tab/set', screen: 'projects' });
  });

  test('every featured card has a title; repository links point to GitHub over https', async ({ page }) => {
    const featured = page.getByRole('region', { name: 'Featured' });
    const cards = featured.getByRole('listitem').filter({ has: page.getByRole('heading', { level: 4 }) });
    const count = await cards.count();
    expect(count, 'featured cards').toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      await expect(cards.nth(i).getByRole('heading', { level: 4 })).toHaveText(/\S/);
    }
    const repos = featured.getByRole('link', { name: /repo/i });
    expect(await repos.count(), 'featured repository links').toBeGreaterThan(0);
    for (const link of await repos.all()) {
      await expect(link).toHaveAttribute('href', /^https:\/\/github\.com\/[^/]+\/[^/]+/);
      // An external link opens in a new tab without handing the opener over.
      await expect(link).toHaveAttribute('target', '_blank');
      await expect(link).toHaveAttribute('rel', /noopener/);
    }
  });

  test('"More projects" lists further projects, each link named after its project', async ({ page }) => {
    const more = page.getByRole('region', { name: 'More projects' });
    const items = more.getByRole('listitem');
    expect(await items.count(), 'further projects').toBeGreaterThan(0);
    await expect(items.first()).toBeVisible();
    for (const link of await more.getByRole('link').all()) {
      await expect(link).toHaveAttribute('href', /^https:\/\//);
      // Each link names its project, so a list of "Repo" links stays distinguishable.
      await expect(link).toHaveAccessibleName(/.+:.+/);
    }
  });

  test('the card about this app leads to the QA Lab and moves focus to its title', { tag: '@critical' }, async ({ page }) => {
    await page.getByRole('button', { name: 'How it is tested' }).click();
    await expect(page).toHaveURL(/#\/lab$/);
    await expect(ui.screen(page, /^qa lab$/i)).toBeVisible();
    await expect(ui.sectionTitle(page)).toBeFocused();
    await expect.poll(() => page.evaluate(() => window.__site!.getState().screen)).toBe('lab');
  });
});
