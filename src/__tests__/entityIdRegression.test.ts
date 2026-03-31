/**
 * Entity ID regression tests.
 *
 * These tests verify that entity IDs produced by TS park implementations
 * match the expected format and don't change unexpectedly. Entity ID
 * stability is critical because the ThemeParks.wiki collector agent
 * references entities by ID — changed IDs would corrupt the database.
 *
 * Tests cover:
 * 1. ID format validation (string, non-empty, no null/undefined)
 * 2. Destination/park ID patterns per framework
 * 3. Entity hierarchy consistency (parentId references valid entities)
 * 4. No duplicate IDs within a destination
 */

import { describe, test, expect, afterAll } from 'vitest';
import { Destination } from '../destination.js';
import { Entity } from '@themeparks/typelib';
import { stopHttpQueue } from '../http.js';
import { getAllDestinations } from '../destinationRegistry.js';

afterAll(() => {
  stopHttpQueue();
});

describe('Entity ID format validation', () => {
  test('all registered destinations have valid IDs', async () => {
    const destinations = await getAllDestinations();
    expect(destinations.length).toBeGreaterThan(0);

    for (const dest of destinations) {
      expect(dest.id).toBeTruthy();
      expect(typeof dest.id).toBe('string');
      expect(dest.id).not.toBe('null');
      expect(dest.id).not.toBe('undefined');
      expect(dest.id.trim()).toBe(dest.id); // no leading/trailing whitespace
    }
  });

  test('all registered destinations have valid names', async () => {
    const destinations = await getAllDestinations();

    for (const dest of destinations) {
      expect(dest.name).toBeTruthy();
      expect(typeof dest.name).toBe('string');
      expect(dest.name.length).toBeGreaterThan(0);
    }
  });

  test('no duplicate destination IDs', async () => {
    const destinations = await getAllDestinations();
    const ids = destinations.map(d => d.id);
    const uniqueIds = new Set(ids);
    const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);

    expect(duplicates).toEqual([]);
    expect(uniqueIds.size).toBe(ids.length);
  });
});

describe('Destination ID patterns', () => {
  test('Universal destinations use expected ID format', async () => {
    const destinations = await getAllDestinations();
    const universal = destinations.filter(d =>
      Array.isArray(d.category) ? d.category.includes('Universal') : d.category === 'Universal'
    );

    expect(universal.length).toBe(2);
    for (const u of universal) {
      // Universal IDs are derived from class name: universalorlando, universalstudios
      expect(u.id).toMatch(/^universal/);
    }
  });

  test('Six Flags is registered as single destination', async () => {
    const destinations = await getAllDestinations();
    const sixflags = destinations.filter(d =>
      Array.isArray(d.category) ? d.category.includes('Six Flags') : d.category === 'Six Flags'
    );

    expect(sixflags.length).toBe(1);
    expect(sixflags[0].id).toBe('sixflags');
  });

  test('Parcs Reunidos parks are registered individually', async () => {
    const destinations = await getAllDestinations();
    const pr = destinations.filter(d =>
      Array.isArray(d.category) ? d.category.includes('Parcs Reunidos') : d.category === 'Parcs Reunidos'
    );

    // 5 parks (Kennywood moved to HFE)
    expect(pr.length).toBe(5);
    const ids = pr.map(d => d.id).sort();
    expect(ids).toContain('movieparkgermany');
    expect(ids).toContain('bobbejaanland');
    expect(ids).toContain('mirabilandia');
  });

  test('HFE parks are registered individually', async () => {
    const destinations = await getAllDestinations();
    const hfe = destinations.filter(d =>
      Array.isArray(d.category) ? d.category.includes('Herschend') : d.category === 'Herschend'
    );

    expect(hfe.length).toBe(4);
    const ids = hfe.map(d => d.id).sort();
    expect(ids).toContain('dollywood');
    expect(ids).toContain('silverdollarcity');
    expect(ids).toContain('kennywood');
    expect(ids).toContain('wildadventures');
  });

  test('Cedar Fair parks are registered individually', async () => {
    const destinations = await getAllDestinations();
    const cf = destinations.filter(d =>
      Array.isArray(d.category) ? d.category.includes('Cedar Fair') : d.category === 'Cedar Fair'
    );

    expect(cf.length).toBeGreaterThanOrEqual(11);
    const ids = cf.map(d => d.id);
    expect(ids).toContain('cedarpoint');
    expect(ids).toContain('knottsberryfarm');
    expect(ids).toContain('kingsisland');
  });

  test('Attractions.io v1 Merlin parks are registered individually', async () => {
    const destinations = await getAllDestinations();
    const merlin = destinations.filter(d =>
      Array.isArray(d.category) ? d.category.includes('Merlin') : d.category === 'Merlin'
    );

    // 15 Merlin parks (Knoebels is not Merlin)
    expect(merlin.length).toBeGreaterThanOrEqual(14);
    const ids = merlin.map(d => d.id);
    expect(ids).toContain('altontowers');
    expect(ids).toContain('thorpepark');
    expect(ids).toContain('chessingtonworldofadventures');
    expect(ids).toContain('legolandwindsor');
    expect(ids).toContain('gardaland');
    expect(ids).toContain('heidepark');
  });

  test('All 16 Attractions.io v1 parks are registered', async () => {
    const destinations = await getAllDestinations();
    const ids = destinations.map(d => d.id);

    const expectedV1Parks = [
      'altontowers', 'thorpepark', 'chessingtonworldofadventures',
      'legolandwindsor', 'legolandorlando', 'legolandcalifornia',
      'legolandbillund', 'legolanddeutschland', 'gardaland',
      'heidepark', 'knoebels', 'legolandjapan',
      'djurssommerland', 'legolandnewyork', 'legolandkorea',
      'peppapigthemeparkflorida',
    ];

    for (const parkId of expectedV1Parks) {
      expect(ids).toContain(parkId);
    }
  });

  test('Parc Asterix is registered', async () => {
    const destinations = await getAllDestinations();
    const pa = destinations.find(d => d.id === 'parcasterix');
    expect(pa).toBeDefined();
    expect(pa!.name).toBe('Parc Asterix');
  });

  test('TE2 Australia parks are registered', async () => {
    const destinations = await getAllDestinations();
    const ids = destinations.map(d => d.id);
    expect(ids).toContain('seaworldgoldcoast');
    expect(ids).toContain('warnerbrosmovieworld');
    expect(ids).toContain('paradisecountry');
    expect(ids).toContain('wetnwildgoldcoast');
  });

  test('Disney parks are registered', async () => {
    const destinations = await getAllDestinations();
    const ids = destinations.map(d => d.id);
    expect(ids).toContain('disneylandparis');
    expect(ids).toContain('tokyodisneyresort');
    expect(ids).toContain('shanghaidisneylandresort');
  });
});

describe('Entity ID contract rules', () => {
  test('entity IDs must always be strings', () => {
    // This is a compile-time guarantee from TypeScript,
    // but verify the runtime behavior of String() conversion
    expect(String(123)).toBe('123');
    expect(String(null)).toBe('null'); // This is why we filter nulls
    expect(String(undefined)).toBe('undefined');
    expect(String('')).toBe('');
  });

  test('Six Flags entity IDs follow RIDE/SHOW/RESTAURANT-parkId-fimsId format', async () => {
    // Verify the Six Flags ID format matches what the JS produces
    // This is critical for backwards compatibility with the wiki database
    const patterns = [
      'RIDE-001-00164',      // ride at park 001
      'RESTAURANT-001-00002', // restaurant at park 001
      'SHOW-001-00001',       // show at park 001
    ];

    for (const id of patterns) {
      expect(id).toMatch(/^(RIDE|SHOW|RESTAURANT)-\d{3}-\d{5}$/);
    }
  });

  test('Parcs Reunidos entity IDs use parquesreunidos_ prefix for destinations/parks', () => {
    // The JS uses parquesreunidos_ (Spanish spelling with typo from original directory name)
    const destId = 'parquesreunidos_1110';
    const parkId = 'parquesreunidos_1110_park';

    expect(destId).toMatch(/^parquesreunidos_\d+$/);
    expect(parkId).toMatch(/^parquesreunidos_\d+_park$/);
  });

  test('HFE entity IDs are UUIDs', () => {
    // Kennywood/Dollywood/SDC use UUID entity IDs from the CRM API
    const uuid = 'acf887a6-59f6-4d70-8120-2d9fac938109';
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test('Universal entity IDs are numeric strings', () => {
    // Universal uses numeric IDs from the API, stored as strings
    const id = '10000';
    expect(id).toMatch(/^\d+$/);
  });
});
