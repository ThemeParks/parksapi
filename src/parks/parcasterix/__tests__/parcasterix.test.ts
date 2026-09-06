import {describe, it, expect} from 'vitest';
import {buildLocalisedName, type POIEntry} from '../parcasterix.js';

const poi = (title: string, titles: Record<string, string>): POIEntry => ({
  drupal_id: 31303,
  title,
  titles,
  latitude: 49.13675,
  longitude: 2.573816,
  _type: 'attraction',
});

describe('buildLocalisedName', () => {
  it('returns every culture the offline package carried', () => {
    expect(
      buildLocalisedName(
        poi('Romulus and Rapidus', {
          en: 'Romulus and Rapidus',
          fr: 'Romus et Rapidus',
          es: 'Romus y Rápidus',
          nl: 'Romus en Rapidus',
        }),
      ),
    ).toEqual({
      en: 'Romulus and Rapidus',
      fr: 'Romus et Rapidus',
      es: 'Romus y Rápidus',
      nl: 'Romus en Rapidus',
    });
  });

  // The French title is what makes an existing wiki entity still recognisable
  // after Parc Asterix translated its whole POI list to English.
  it('keeps the French title alongside the English one', () => {
    const name = buildLocalisedName(
      poi('Justforkix', {en: 'Justforkix', fr: 'Goudurix'}),
    );
    expect(name).toEqual({en: 'Justforkix', fr: 'Goudurix'});
  });

  it('falls back to a plain string when only one culture is present', () => {
    expect(buildLocalisedName(poi('Toutatis', {fr: 'Toutatis'}))).toBe('Toutatis');
  });

  it('falls back to a plain string when no culture is present', () => {
    expect(buildLocalisedName(poi('Toutatis', {}))).toBe('Toutatis');
  });

  it('drops empty translations rather than publishing a blank name', () => {
    expect(
      buildLocalisedName(poi('Enigmatix', {en: 'Enigmatix', nl: '', es: ''})),
    ).toBe('Enigmatix');
  });

  it('tolerates a POI with no titles map at all', () => {
    const legacy = {...poi('Enigmatix', {})} as POIEntry;
    delete (legacy as Partial<POIEntry>).titles;
    expect(buildLocalisedName(legacy)).toBe('Enigmatix');
  });
});
