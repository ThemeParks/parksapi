/**
 * HTML utility functions for decoding entities and stripping tags.
 * Used by park implementations that receive HTML-encoded data from APIs.
 */

/**
 * Decode HTML entities in a string.
 * Handles named entities (&amp;, &lt;, etc.), decimal (&#34;),
 * and hex (&#x27;) entities.
 *
 * Single-pass decoding: each entity is matched once and replaced with its
 * literal character. This avoids the double-decode trap where running
 * substitutions sequentially would cause `&#38;amp;` (literal `&amp;`)
 * to become `&` instead of staying as `&amp;`.
 *
 * @param str String with HTML entities
 * @returns Decoded string
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeHtmlEntities(str: string): string {
  if (!str) return '';

  // One pass over the string. The combined regex matches hex entities,
  // decimal entities, and named entities; the replace callback decides
  // how to decode each match. Because each entity is consumed in a single
  // pass, decoded output is never re-scanned for further entities.
  return str.replace(/&(?:#x([0-9a-fA-F]+)|#(\d+)|(amp|lt|gt|quot|apos|nbsp));/g,
    (match, hex, dec, name) => {
      if (hex !== undefined) return String.fromCharCode(parseInt(hex, 16));
      if (dec !== undefined) return String.fromCharCode(parseInt(dec, 10));
      if (name !== undefined) return NAMED_ENTITIES[name];
      return match;
    });
}

/**
 * Strip HTML tags from a string.
 * Removes all HTML tags and trims whitespace.
 *
 * Implemented as a single-pass character walker that tracks `<` / `>`
 * nesting depth rather than a regex. This avoids two CodeQL issues that
 * the old `/<[^>]*>/g` pattern had:
 *   - `js/incomplete-multi-character-sanitization` — adversarial inputs
 *     like `<scrip<script>t>` would leak through a single regex pass.
 *   - `js/polynomial-redos` — `<[^>]*` could backtrack on long runs of `<`.
 *
 * The walker counts every `<` as opening a tag region and every `>`
 * (while depth > 0) as closing one; characters are only emitted at
 * depth 0. Linear time, no backtracking, idempotent.
 *
 * @param str String with HTML tags
 * @returns Clean string without tags
 */
export function stripHtmlTags(str: string): string {
  if (!str) return '';
  let out = '';
  let depth = 0;
  let outerTagStart = -1;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '<') {
      if (depth === 0) outerTagStart = i;
      depth++;
    } else if (ch === '>' && depth > 0) {
      depth--;
    } else if (depth === 0) {
      out += ch;
    }
  }
  // If we hit EOF mid-tag, the outermost `<` was unmatched — preserve
  // everything from that point so legitimate text like `2 < 3` survives.
  if (depth > 0 && outerTagStart >= 0) {
    out += str.slice(outerTagStart);
  }
  return out.trim();
}
