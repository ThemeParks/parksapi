import {describe, it, expect} from 'vitest';
import {
  generateMappings,
  getUnmatchedNewEntities,
  normalizeName,
  nameSimilarity,
  haversineMeters,
  geoScore,
  bestNameScore,
  type WikiEntity,
  type NewEntity,
} from '../matcher.js';

// Two points ~11m apart at Parc Asterix's latitude.
const LAT = 49.13675;
const LNG = 2.573816;
const metresEast = (m: number) => LNG + m / (111320 * Math.cos((LAT * Math.PI) / 180));

const wiki = (
  externalId: string,
  name: string,
  opts: Partial<WikiEntity> = {},
): WikiEntity => ({
  wikiId: `uuid-${externalId}`,
  externalId,
  name,
  entityType: 'ATTRACTION',
  latitude: LAT,
  longitude: LNG,
  ...opts,
});

const fresh = (
  newId: string,
  name: string,
  opts: Partial<NewEntity> = {},
): NewEntity => ({
  newId,
  name,
  entityType: 'ATTRACTION',
  latitude: LAT,
  longitude: LNG,
  ...opts,
});

describe('normalizeName', () => {
  it('folds accents rather than deleting the letter', () => {
    expect(normalizeName('Aérodynamix')).toBe('aerodynamix');
    expect(normalizeName('Discobélix')).toBe('discobelix');
    expect(normalizeName('Pégase Express')).toBe('pegaseexpress');
  });

  it('makes accented and unaccented spellings compare equal', () => {
    expect(normalizeName('Aérodynamix')).toBe(normalizeName('Aerodynamix'));
  });

  it('strips narrow no-break spaces and punctuation', () => {
    expect(normalizeName('Le Relais Gaulois')).toBe('lerelaisgaulois');
    expect(normalizeName("C'est du délire !")).toBe('cestdudelire');
  });
});

describe('nameSimilarity', () => {
  it('scores identical strings at 100', () => {
    expect(nameSimilarity('toutatis', 'toutatis')).toBe(100);
  });

  it('scores an empty string at 0', () => {
    expect(nameSimilarity('', 'toutatis')).toBe(0);
    expect(nameSimilarity('toutatis', '')).toBe(0);
  });

  it('rewards containment', () => {
    expect(nameSimilarity('toutatis', 'bytoutatis')).toBeGreaterThan(70);
  });

  it('scores unrelated translations near zero', () => {
    expect(nameSimilarity('goudurix', 'justforkix')).toBeLessThan(50);
  });
});

describe('geoScore', () => {
  it('treats coordinates within 10m as identical', () => {
    expect(geoScore(0)).toBe(100);
    expect(geoScore(10)).toBe(100);
  });

  it('decays with distance and bottoms out at 250m', () => {
    expect(geoScore(130)).toBeGreaterThan(0);
    expect(geoScore(130)).toBeLessThan(100);
    expect(geoScore(250)).toBe(0);
    expect(geoScore(1000)).toBe(0);
  });
});

describe('bestNameScore', () => {
  it('uses the best of the primary name and every alternate locale', () => {
    const candidate = fresh('31357', 'Justforkix', {altNames: ['Goudurix']});
    expect(bestNameScore('Goudurix', candidate)).toBe(100);
    expect(bestNameScore('Justforkix', candidate)).toBe(100);
  });

  it('ignores empty alternates', () => {
    const candidate = fresh('1', 'Toutatis', {altNames: ['']});
    expect(bestNameScore('Toutatis', candidate)).toBe(100);
  });
});

describe('generateMappings', () => {
  it('leaves PARK and DESTINATION entities alone', () => {
    const mappings = generateMappings(
      [
        wiki('parcasterix', 'Parc Asterix', {entityType: 'DESTINATION'}),
        wiki('parcasterixpark', 'Parc Asterix', {entityType: 'PARK'}),
      ],
      [fresh('parcasterix', 'Parc Asterix', {entityType: 'DESTINATION'})],
    );
    expect(mappings).toHaveLength(0);
  });

  it('matches an unchanged name exactly', () => {
    const [m] = generateMappings([wiki('2482', 'Enigmatix')], [fresh('31324', 'Enigmatix')]);
    expect(m.confidence).toBe('exact');
    expect(m.newExternalId).toBe('31324');
    expect(m.status).toBe('confirmed');
  });

  it('never matches across entity types', () => {
    const [m] = generateMappings(
      [wiki('20', 'Le Spectacle', {entityType: 'SHOW'})],
      [fresh('31483', 'Le Spectacle', {entityType: 'RESTAURANT'})],
    );
    expect(m.confidence).toBe('unmatched');
    expect(m.newExternalId).toBeNull();
  });

  // The regression this matcher was rewritten for: Parc Asterix renumbered
  // every POI and translated every name from French to English in the same
  // release. A name-gated matcher finds nothing here.
  it('matches a fully translated name on identical coordinates alone', () => {
    const [m] = generateMappings(
      [wiki('11', 'Goudurix')],
      [fresh('31357', 'Justforkix')],
    );
    expect(m.confidence).toBe('fuzzy');
    expect(m.newExternalId).toBe('31357');
    expect(m.distance).toBe(0);
  });

  it('matches a translated name through an alternate locale', () => {
    const [m] = generateMappings(
      [wiki('11', 'Goudurix')],
      [
        fresh('31357', 'Justforkix', {
          altNames: ['Goudurix'],
          longitude: metresEast(400),
        }),
      ],
    );
    expect(m.confidence).toBe('exact');
    expect(m.newExternalId).toBe('31357');
  });

  it('rejects a pair more than 500m apart however well the names read', () => {
    const [m] = generateMappings(
      [wiki('2482', 'Enigmatix')],
      [fresh('31324', 'Enigmatix', {longitude: metresEast(900)})],
    );
    expect(m.confidence).toBe('unmatched');
  });

  it('still matches a ride that moved but kept its name', () => {
    const [m] = generateMappings(
      [wiki('2482', 'Enigmatix')],
      [fresh('31324', 'Enigmatix', {longitude: metresEast(300)})],
    );
    expect(m.newExternalId).toBe('31324');
  });

  it('matches when neither side has coordinates', () => {
    const [m] = generateMappings(
      [wiki('2482', 'Enigmatix', {latitude: undefined, longitude: undefined})],
      [fresh('31324', 'Enigmatix', {latitude: undefined, longitude: undefined})],
    );
    expect(m.confidence).toBe('exact');
    expect(m.distance).toBeNull();
  });

  // Adjacent POIs both land inside the "identical coordinates" radius, so geo
  // alone ties them. The name has to break that tie, which it only can if the
  // combined score is not clamped at 100 before ranking.
  it('uses names to separate two neighbours that both sit on the same spot', () => {
    const mappings = generateMappings(
      [
        wiki('498173', 'The Flight of Ibis'),
        wiki('498174', 'The Descent of the Nile'),
      ],
      [
        fresh('31388', 'The Flight of Ibis', {longitude: metresEast(4)}),
        fresh('31389', 'The Descent of the Nile'),
      ],
    );
    const byOld = Object.fromEntries(mappings.map(m => [m.oldExternalId, m.newExternalId]));
    expect(byOld['498173']).toBe('31388');
    expect(byOld['498174']).toBe('31389');
  });

  it('never assigns one new entity to two wiki entities', () => {
    const mappings = generateMappings(
      [wiki('1', 'Menhir Express'), wiki('2', 'Menhir Express')],
      [fresh('31363', 'The Menhir Express')],
    );
    const claimed = mappings.map(m => m.newExternalId).filter(Boolean);
    expect(claimed).toHaveLength(1);
    expect(mappings.filter(m => m.confidence === 'unmatched')).toHaveLength(1);
  });

  it('marks a retired entity unmatched and skipped', () => {
    const mappings = generateMappings(
      [
        wiki('2482', 'Enigmatix'),
        wiki('126836', 'Du Rififi dans la basse-cour', {
          entityType: 'SHOW',
          longitude: metresEast(900),
        }),
      ],
      [fresh('31324', 'Enigmatix')],
    );
    const retired = mappings.find(m => m.oldExternalId === '126836')!;
    expect(retired.confidence).toBe('unmatched');
    expect(retired.status).toBe('skip');
    expect(retired.newExternalId).toBeNull();
  });

  it('is order-independent', () => {
    const w = [wiki('a', 'Enigmatix'), wiki('b', 'Hydrolix'), wiki('c', 'Lavomatix')];
    const n = [
      fresh('1', 'Hydrolix', {longitude: metresEast(2)}),
      fresh('2', 'Laundromatix', {longitude: metresEast(4)}),
      fresh('3', 'Enigmatix', {longitude: metresEast(6)}),
    ];
    const key = (ms: ReturnType<typeof generateMappings>) =>
      ms.map(m => `${m.oldExternalId}->${m.newExternalId}`).sort().join(',');
    expect(key(generateMappings(w, n))).toBe(
      key(generateMappings([...w].reverse(), [...n].reverse())),
    );
  });

  it('sorts exact matches ahead of fuzzy ones, and unmatched last', () => {
    const mappings = generateMappings(
      [
        wiki('1', 'Goudurix'),
        wiki('2', 'Enigmatix'),
        wiki('3', 'Retired Ride', {longitude: metresEast(900)}),
      ],
      [
        fresh('n1', 'Justforkix', {longitude: metresEast(2)}),
        fresh('n2', 'Enigmatix'),
      ],
    );
    expect(mappings.map(m => m.confidence)).toEqual(['exact', 'fuzzy', 'unmatched']);
  });

  it('reports a confidence score inside 0-100', () => {
    const mappings = generateMappings(
      [wiki('1', 'Enigmatix')],
      [fresh('n1', 'Enigmatix')],
    );
    expect(mappings[0].confidenceScore).toBeGreaterThanOrEqual(0);
    expect(mappings[0].confidenceScore).toBeLessThanOrEqual(100);
  });
});

describe('getUnmatchedNewEntities', () => {
  it('returns only new entities nothing claimed', () => {
    const newEntities = [
      fresh('31324', 'Enigmatix'),
      fresh('34631', 'The Forest of No Return', {longitude: metresEast(900)}),
      fresh('parcasterixpark', 'Parc Asterix', {entityType: 'PARK'}),
    ];
    const mappings = generateMappings([wiki('2482', 'Enigmatix')], newEntities);
    const unmatched = getUnmatchedNewEntities(mappings, newEntities);
    expect(unmatched.map(e => e.newId)).toEqual(['34631']);
  });
});

describe('haversineMeters', () => {
  it('is zero for the same point', () => {
    expect(haversineMeters(LAT, LNG, LAT, LNG)).toBe(0);
  });

  it('measures a known east-west offset', () => {
    expect(haversineMeters(LAT, LNG, LAT, metresEast(100))).toBeCloseTo(100, 0);
  });
});
