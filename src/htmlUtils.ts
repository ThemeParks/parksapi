/**
 * HTML utility functions for decoding entities and stripping tags.
 * Used by park implementations that receive HTML-encoded data from APIs.
 */

/**
 * Decode HTML entities in a string.
 * Handles named entities (&amp;, &lt;, etc.), decimal (&#34;),
 * and hex (&#x27;) entities.
 *
 * @param str String with HTML entities
 * @returns Decoded string
 */
export function decodeHtmlEntities(str: string): string {
  if (!str) return '';

  return str
    // Hex entities: &#x27; → '
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    // Decimal entities: &#34; → "
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    // Named entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
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
