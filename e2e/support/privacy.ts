/**
 * The privacy rule the suite enforces on every public page: no phone number, in any spelling.
 *
 * PHONE_RE matches a Romanian mobile number (+40 7xx xxx xxx) in the spellings people actually write:
 *   start   +40, 0040 or 40, then maybe a trunk 0 or "(0)"; or, without a country prefix, the
 *           trunk 0 (maybe after "(", maybe before a space: 0 7xx xxx xxx). A bare 9-digit run is
 *           never taken for a number.
 *   number  a 7 and 8 more digits. Between groups of at least two digits, one or two of
 *           space . - / ( ) may stand: 07xx xxx xxx, 07xx xx xx xx, (07xx) xxx xxx, +40.7xx.xxx.xxx.
 *   edges   no letter, digit, "+" or dot right before, except the dot of a whole-word Tel., Mob.
 *           or Nr. ("Tel.07…" counts); no letter or digit right after.
 * The edge rules keep it off minified code and SVG path data, which are full of digit runs: a dot
 * right before a run is a decimal point (".07…", "c.07…", "return.07…"), and path data chains
 * one-digit numbers with spaces, dots and minus signs.
 *
 * Its fixtures (unit/phone-pattern.spec.ts) are built from zero digits at runtime, so no number,
 * real or dummy, is ever written into this repository.
 */
const SEP = String.raw`[\s.\-/()]`;
/** Optional separators between two digit groups of at least two digits each. */
const GAP = String.raw`(?:(?<=\d\d)${SEP}{1,2}(?=\d\d))?`;
/** The abbreviations whose dot may stand right before a number. */
const ABBR = String.raw`\b(?:[Tt]el|TEL|[Mm]ob|MOB|[Nn]r|NR)`;

export const PHONE_RE = new RegExp(
  String.raw`(?<![\w+])(?<!(?<!${ABBR})\.)` +
    String.raw`(?:(?:\+|00)40${SEP}{0,2}(?:\(0\)${SEP}?|0)?|40\s?(?:\(0\)\s?|0)?|\(?0\s?)` +
    String.raw`7(?:${GAP}\d){8}(?!\w)`,
);

/** A generic international number written for people (+<country> and 8–13 more digits, grouped). */
export const INTL_PHONE_RE = /(?<![\w+])\+\d{1,3}[\s.\-()]{0,2}(?:\d[\s.\-()]{0,2}){8,13}\d?(?!\w)/;
