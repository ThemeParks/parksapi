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
 * @param str String with HTML tags
 * @returns Clean string without tags
 */
export function stripHtmlTags(str: string): string {
  if (!str) return '';
  return str.replace(/<[^>]*>/g, '').trim();
}
