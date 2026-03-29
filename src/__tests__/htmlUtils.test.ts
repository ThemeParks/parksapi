/**
 * Test HTML utility functions
 */
import { describe, test, expect } from 'vitest';
import { decodeHtmlEntities, stripHtmlTags } from '../htmlUtils.js';

describe('decodeHtmlEntities', () => {
  test('decodes named entities', () => {
    expect(decodeHtmlEntities('Tom &amp; Jerry')).toBe('Tom & Jerry');
    expect(decodeHtmlEntities('&lt;script&gt;')).toBe('<script>');
    expect(decodeHtmlEntities('&quot;hello&quot;')).toBe('"hello"');
    expect(decodeHtmlEntities('it&apos;s')).toBe("it's");
  });

  test('decodes numeric decimal entities', () => {
    expect(decodeHtmlEntities('&#34;hello&#34;')).toBe('"hello"');
    expect(decodeHtmlEntities('&#39;test&#39;')).toBe("'test'");
    expect(decodeHtmlEntities('100&#176; Fun')).toBe('100° Fun');
  });

  test('decodes hex entities', () => {
    expect(decodeHtmlEntities("Rock &#x27;n&#x27; Roll")).toBe("Rock 'n' Roll");
    expect(decodeHtmlEntities('&#x26;')).toBe('&');
  });

  test('handles mixed entities', () => {
    expect(decodeHtmlEntities('&amp; &#34; &#x27;')).toBe('& " \'');
  });

  test('returns empty string for empty input', () => {
    expect(decodeHtmlEntities('')).toBe('');
  });

  test('returns original string if no entities', () => {
    expect(decodeHtmlEntities('hello world')).toBe('hello world');
  });

  test('handles &nbsp;', () => {
    expect(decodeHtmlEntities('hello&nbsp;world')).toBe('hello world');
  });

  test('handles &#125; (closing brace)', () => {
    expect(decodeHtmlEntities('&#125;')).toBe('}');
  });
});

describe('stripHtmlTags', () => {
  test('strips <p> tags', () => {
    expect(stripHtmlTags('<p>Blue Streak</p>')).toBe('Blue Streak');
  });

  test('strips multiple tags', () => {
    expect(stripHtmlTags('<p>Hello <b>World</b></p>')).toBe('Hello World');
  });

  test('handles empty string', () => {
    expect(stripHtmlTags('')).toBe('');
  });

  test('trims whitespace', () => {
    expect(stripHtmlTags('  <p> Hello </p>  ')).toBe('Hello');
  });

  test('handles self-closing tags', () => {
    expect(stripHtmlTags('Hello<br/>World')).toBe('HelloWorld');
  });
});
