import { expect, test } from '@playwright/test';
import { PHONE_RE } from '../e2e/support/privacy';

/**
 * The privacy pattern needs tests of its own: a pattern that misses a spelling lets a number ship,
 * and one that fires on look-alikes (minified code, SVG path data, decimals) gets switched off.
 * Every sample is built at runtime from zero digits, so no number is ever written into the repo.
 */
const z = (n: number) => '0'.repeat(n);

/** [label, text]: the label writes each dummy digit as x. */
const PHONE_SPELLINGS: readonly (readonly [string, string])[] = [
  ['07xx xxx xxx', `07${z(2)} ${z(3)} ${z(3)}`],
  ['07xxxxxxxx', `07${z(8)}`],
  ['07xx.xxx.xxx', `07${z(2)}.${z(3)}.${z(3)}`],
  ['07xx-xxx-xxx', `07${z(2)}-${z(3)}-${z(3)}`],
  ['07xx/xxx xxx', `07${z(2)}/${z(3)} ${z(3)}`],
  ['07xx xx xx xx', `07${z(2)} ${z(2)} ${z(2)} ${z(2)}`],
  ['(07xx) xxx xxx', `(07${z(2)}) ${z(3)} ${z(3)}`],
  ['0 7xx xxx xxx', `0 7${z(2)} ${z(3)} ${z(3)}`],
  ['+40 7xx xxx xxx', `+40 7${z(2)} ${z(3)} ${z(3)}`],
  ['+40 0 7xx xxx xxx', `+40 0 7${z(2)} ${z(3)} ${z(3)}`],
  ['+407xxxxxxxx', `+407${z(8)}`],
  ['+40-7xx-xxx-xxx', `+40-7${z(2)}-${z(3)}-${z(3)}`],
  ['+40.7xx.xxx.xxx', `+40.7${z(2)}.${z(3)}.${z(3)}`],
  ['+40 (0)7xx xxx xxx', `+40 (0)7${z(2)} ${z(3)} ${z(3)}`],
  ['0040 7xx xxx xxx', `0040 7${z(2)} ${z(3)} ${z(3)}`],
  ['tel:+407xxxxxxxx', `tel:+407${z(8)}`],
  ['Tel.07xx xxx xxx', `Tel.07${z(2)} ${z(3)} ${z(3)}`],
  ['Mob.07xxxxxxxx', `Mob.07${z(8)}`],
  ['call 07xxxxxxxx.', `call 07${z(8)}.`],
];

/** Digit runs that only look like a number: decimals, SVG path data, minified code, longer runs. */
const NOT_PHONES: readonly (readonly [string, string])[] = [
  ['decimal .07xxxxxxxx', `.07${z(8)}`],
  ['decimal 0.07xxxxxxxx', `0.07${z(8)}`],
  ['decimal 40.7xxxxxxxx', `40.7${z(8)}`],
  ['glued to a name a07xxxxxxxx', `a07${z(8)}`],
  ['longer run 107xxxxxxxx', `107${z(8)}`],
  ['longer run 07xxxxxxxxxxx', `07${z(11)}`],
  ['too short 07xxxxxxx', `07${z(7)}`],
  ['SVG path digits 0 7 x x x x x x x x', `M2 0 7 ${Array.from({ length: 8 }, () => '0').join(' ')}`],
  ['SVG path decimals -.07xx-.xxx.xxx', `l-.07${z(2)}-.${z(3)}.${z(3)}`],
  ['SVG path decimal after a command c.07xx.xxx.xxx', `c.07${z(2)}.${z(3)}.${z(3)}`],
  ['minified decimal after a keyword return.07xxxxxxxx*e', `return.07${z(8)}*e`],
  ['minified decimal after a keyword case.07xxxxxxxx:', `case.07${z(8)}:`],
];

test.describe('phone-number pattern', { tag: '@unit' }, () => {
  for (const [label, text] of PHONE_SPELLINGS) {
    test(`catches ${label}`, () => {
      expect(PHONE_RE.test(text)).toBe(true);
      expect(PHONE_RE.test(`Contact: ${text} (evenings)`), 'also inside a sentence').toBe(true);
    });
  }
  for (const [label, text] of NOT_PHONES) {
    test(`leaves alone ${label}`, () => {
      expect(PHONE_RE.test(text)).toBe(false);
    });
  }
});
