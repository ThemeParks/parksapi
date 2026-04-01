/**
 * Entity ID migration matcher.
 *
 * Matches old wiki entities (by externalId) to new TS entities using
 * three-tier confidence: exact name, fuzzy name + coordinates, unmatched.
 */

// ── Types ──────────────────────────────────────────────────────

export interface WikiEntity {
  wikiId: string;       // Public UUID on api.themeparks.wiki
  externalId: string;   // Current _id (e.g., "attr_gforce")
  name: string;
  entityType: string;   // ATTRACTION, SHOW, RESTAURANT, PARK, DESTINATION
  latitude?: number;
  longitude?: number;
}

export interface NewEntity {
  newId: string;        // New _id (e.g., UUID from API)
  name: string;
  entityType: string;
  latitude?: number;
  longitude?: number;
}

export type MatchConfidence = 'exact' | 'fuzzy' | 'unmatched';

export interface Mapping {
  wikiId: string;
  oldExternalId: string;
  oldName: string;
  entityType: string;
  oldLatitude?: number;
  oldLongitude?: number;
  newExternalId: string | null;
  newName: string | null;
  confidence: MatchConfidence;
  confidenceScore: number;   // 0-100
  distance: number | null;   // meters between coordinates, null if unavailable
  status: 'confirmed' | 'skip'; // user can mark as skip
}

// ── Normalization ──────────────────────────────────────────────

/** Normalize a name for comparison: lowercase, strip non-alphanumeric */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ── Coordinate distance ────────────────────────────────────────

/** Haversine distance in meters between two lat/lng points */
export function haversineMeters(
  lat1: number, lng1: number,
  lat2: number, lng2: number,
): number {
  const R = 6371000; // Earth radius in meters
  const toRad = (deg: number) => deg * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Fuzzy name similarity ──────────────────────────────────────

/**
 * Simple character-overlap similarity between two normalized strings.
 * Returns 0-100 percentage.
 */
export function nameSimilarity(a: string, b: string): number {
  if (a === b) return 100;
  if (!a || !b) return 0;

  // Substring containment gives high score
  if (a.includes(b) || b.includes(a)) {
    const shorter = Math.min(a.length, b.length);
    const longer = Math.max(a.length, b.length);
    return Math.round((shorter / longer) * 100);
  }

  // Character bigram overlap (Dice coefficient)
  const bigrams = (s: string): Set<string> => {
    const bg = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) bg.add(s.substring(i, i + 2));
    return bg;
  };

  const bg1 = bigrams(a);
  const bg2 = bigrams(b);
  let overlap = 0;
  for (const b of bg1) {
    if (bg2.has(b)) overlap++;
  }

  return Math.round((2 * overlap) / (bg1.size + bg2.size) * 100);
}

// ── Main matcher ───────────────────────────────────────────────

export function generateMappings(
  wikiEntities: WikiEntity[],
  newEntities: NewEntity[],
): Mapping[] {
  const mappings: Mapping[] = [];

  // Filter out PARK and DESTINATION — their IDs don't change
  const wikiToMatch = wikiEntities.filter(
    e => e.entityType !== 'PARK' && e.entityType !== 'DESTINATION',
  );

  // Track which new entities have been claimed (1:1 mapping)
  const claimedNewIds = new Set<string>();

  // Available new entities pool
  const getAvailable = (entityType: string) =>
    newEntities.filter(n => n.entityType === entityType && !claimedNewIds.has(n.newId));

  // Pass 1: Exact name matches
  for (const wiki of wikiToMatch) {
    const normOld = normalizeName(wiki.name);
    const candidates = getAvailable(wiki.entityType);
    const exact = candidates.find(n => normalizeName(n.name) === normOld);

    if (exact) {
      const dist = (wiki.latitude != null && exact.latitude != null)
        ? haversineMeters(wiki.latitude, wiki.longitude!, exact.latitude, exact.longitude!)
        : null;

      claimedNewIds.add(exact.newId);
      mappings.push({
        wikiId: wiki.wikiId,
        oldExternalId: wiki.externalId,
        oldName: wiki.name,
        entityType: wiki.entityType,
        oldLatitude: wiki.latitude,
        oldLongitude: wiki.longitude,
        newExternalId: exact.newId,
        newName: exact.name,
        confidence: 'exact',
        confidenceScore: 100,
        distance: dist !== null ? Math.round(dist) : null,
        status: 'confirmed',
      });
    }
  }

  // Pass 2: Fuzzy matches for unmatched wiki entities
  const matchedWikiIds = new Set(mappings.map(m => m.wikiId));

  for (const wiki of wikiToMatch) {
    if (matchedWikiIds.has(wiki.wikiId)) continue;

    const normOld = normalizeName(wiki.name);
    const candidates = getAvailable(wiki.entityType);

    // Score each candidate
    let bestCandidate: NewEntity | null = null;
    let bestScore = 0;
    let bestDist: number | null = null;

    for (const candidate of candidates) {
      const similarity = nameSimilarity(normOld, normalizeName(candidate.name));
      if (similarity < 50) continue; // threshold

      let dist: number | null = null;
      if (wiki.latitude != null && candidate.latitude != null) {
        dist = haversineMeters(wiki.latitude, wiki.longitude!, candidate.latitude, candidate.longitude!);
        // Within 100m boosts score, beyond 500m penalizes
        if (dist > 500) continue;
      }

      // Combine name similarity + coordinate proximity
      let score = similarity;
      if (dist !== null && dist < 100) score = Math.min(99, score + 10);

      if (score > bestScore) {
        bestScore = score;
        bestCandidate = candidate;
        bestDist = dist;
      }
    }

    if (bestCandidate && bestScore >= 60) {
      claimedNewIds.add(bestCandidate.newId);
      mappings.push({
        wikiId: wiki.wikiId,
        oldExternalId: wiki.externalId,
        oldName: wiki.name,
        entityType: wiki.entityType,
        oldLatitude: wiki.latitude,
        oldLongitude: wiki.longitude,
        newExternalId: bestCandidate.newId,
        newName: bestCandidate.name,
        confidence: 'fuzzy',
        confidenceScore: bestScore,
        distance: bestDist !== null ? Math.round(bestDist) : null,
        status: 'confirmed',
      });
    } else {
      // Unmatched
      mappings.push({
        wikiId: wiki.wikiId,
        oldExternalId: wiki.externalId,
        oldName: wiki.name,
        entityType: wiki.entityType,
        oldLatitude: wiki.latitude,
        oldLongitude: wiki.longitude,
        newExternalId: null,
        newName: null,
        confidence: 'unmatched',
        confidenceScore: 0,
        distance: null,
        status: 'skip',
      });
    }
  }

  // Sort: exact first, then fuzzy, then unmatched
  const order: Record<MatchConfidence, number> = {exact: 0, fuzzy: 1, unmatched: 2};
  mappings.sort((a, b) => order[a.confidence] - order[b.confidence]);

  return mappings;
}

/**
 * Get new entities that weren't matched to any wiki entity.
 * These are brand new entities that don't exist in the wiki yet.
 */
export function getUnmatchedNewEntities(
  mappings: Mapping[],
  newEntities: NewEntity[],
): NewEntity[] {
  const matchedNewIds = new Set(
    mappings.filter(m => m.newExternalId).map(m => m.newExternalId),
  );
  return newEntities.filter(
    n => !matchedNewIds.has(n.newId) && n.entityType !== 'PARK' && n.entityType !== 'DESTINATION',
  );
}
