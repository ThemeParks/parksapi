/**
 * Entity ID migration matcher.
 *
 * Matches old wiki entities (by externalId) to new TS entities.
 *
 * Names and coordinates are scored as independent pieces of evidence and
 * combined, rather than names acting as a gate. A park that rebuilds its CMS
 * usually keeps its POIs in the same physical place even when every name and
 * every upstream ID changes — Parc Asterix translated its whole POI list from
 * French to English in the same release that renumbered it — so a name-first
 * matcher finds almost nothing there. Either signal can carry a match on its
 * own; agreement between them raises the score.
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
  /**
   * Other names the same entity is known by — typically the other locales of
   * a LocalisedString name. The wiki may be holding any one of them, so every
   * variant is scored and the best one wins.
   */
  altNames?: string[];
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

// ── Tuning ─────────────────────────────────────────────────────

/** At or below this distance the coordinates are treated as identical. */
const GEO_IDENTICAL_M = 10;
/** Beyond this distance coordinates contribute no evidence. */
const GEO_USELESS_M = 250;
/** Beyond this distance a pair is rejected outright, whatever the names say. */
const GEO_REJECT_M = 500;
/** Minimum combined score for the matcher to propose a pair at all. */
const MIN_SCORE = 60;
/** Name score at or above which a pair counts as an "exact" name hit. */
const NAME_EXACT = 100;

// ── Normalization ──────────────────────────────────────────────

/**
 * Normalize a name for comparison: fold accents, lowercase, strip
 * non-alphanumerics.
 *
 * Accent folding matters: without it "Aerodynamix" and "Aérodynamix" are not
 * an exact match, because stripping non-`a-z` characters deletes the accented
 * letter rather than replacing it. Upstream feeds also sprinkle in narrow
 * no-break spaces (U+202F), which the alphanumeric filter removes anyway.
 */
export function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
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

// ── Scoring ────────────────────────────────────────────────────

/**
 * Best name score between a wiki name and every name the new entity answers
 * to (its primary name plus any alternate locales).
 */
export function bestNameScore(oldName: string, candidate: NewEntity): number {
  const normOld = normalizeName(oldName);
  const names = [candidate.name, ...(candidate.altNames ?? [])];
  let best = 0;
  for (const n of names) {
    if (!n) continue;
    const score = nameSimilarity(normOld, normalizeName(n));
    if (score > best) best = score;
  }
  return best;
}

/**
 * Convert a separation in meters into a 0-100 confidence that two records
 * describe the same physical place. Identical coordinates score 100 and decay
 * linearly to 0 at GEO_USELESS_M.
 */
export function geoScore(distanceMeters: number): number {
  if (distanceMeters <= GEO_IDENTICAL_M) return 100;
  if (distanceMeters >= GEO_USELESS_M) return 0;
  const span = GEO_USELESS_M - GEO_IDENTICAL_M;
  return Math.round(100 * (1 - (distanceMeters - GEO_IDENTICAL_M) / span));
}

interface Candidate {
  wiki: WikiEntity;
  entity: NewEntity;
  /** Uncapped combined score, used only for ranking candidates against each other. */
  rankScore: number;
  /** Reported 0-100 confidence. */
  score: number;
  nameScore: number;
  distance: number | null;
}

/**
 * Score one wiki/new pair. Returns null if the pair is impossible (different
 * entity type, or too far apart to be the same place).
 */
function scorePair(wiki: WikiEntity, entity: NewEntity): Candidate | null {
  if (wiki.entityType !== entity.entityType) return null;

  let distance: number | null = null;
  if (
    wiki.latitude != null && wiki.longitude != null &&
    entity.latitude != null && entity.longitude != null
  ) {
    distance = haversineMeters(
      wiki.latitude, wiki.longitude,
      entity.latitude, entity.longitude,
    );
    if (distance > GEO_REJECT_M) return null;
  }

  const nameScore = bestNameScore(wiki.name, entity);
  const geo = distance === null ? null : geoScore(distance);

  // Either signal can carry the match on its own; where both are present and
  // agree, the weaker one adds a modest bonus rather than dragging the pair
  // down. A renamed ride that did not move, and a moved ride that kept its
  // name, both still match.
  const strong = geo === null ? nameScore : Math.max(nameScore, geo);
  const weak = geo === null ? 0 : Math.min(nameScore, geo);

  // The rank score is deliberately uncapped. Neighbouring POIs in a small park
  // routinely sit within the "identical" radius of each other, so several
  // candidates reach a geo score of 100 at once; if the combined score were
  // clamped to 100 they would tie and the weaker signal could no longer break
  // the tie. Two adjacent water rides that swapped upstream IDs get sorted out
  // by their names precisely because the agreement bonus survives above 100.
  const rankScore = strong + weak * 0.15;

  return {
    wiki,
    entity,
    rankScore,
    score: Math.min(100, Math.round(rankScore)),
    nameScore,
    distance,
  };
}

// ── Main matcher ───────────────────────────────────────────────

export function generateMappings(
  wikiEntities: WikiEntity[],
  newEntities: NewEntity[],
): Mapping[] {
  // Filter out PARK and DESTINATION — their IDs don't change
  const wikiToMatch = wikiEntities.filter(
    e => e.entityType !== 'PARK' && e.entityType !== 'DESTINATION',
  );

  // Score every viable pair, then assign globally best-first. A pass-ordered
  // matcher lets an early weak match steal an entity a later stronger one
  // needed; scoring everything up front removes that ordering dependency.
  const candidates: Candidate[] = [];
  for (const wiki of wikiToMatch) {
    for (const entity of newEntities) {
      const scored = scorePair(wiki, entity);
      if (scored && scored.score >= MIN_SCORE) candidates.push(scored);
    }
  }

  // Deterministic ordering: best score, then closest, then stable by ID.
  candidates.sort((a, b) =>
    b.rankScore - a.rankScore ||
    (a.distance ?? Infinity) - (b.distance ?? Infinity) ||
    a.wiki.externalId.localeCompare(b.wiki.externalId) ||
    a.entity.newId.localeCompare(b.entity.newId),
  );

  const claimedWiki = new Set<string>();
  const claimedNew = new Set<string>();
  const matched = new Map<string, Candidate>();

  for (const c of candidates) {
    if (claimedWiki.has(c.wiki.wikiId) || claimedNew.has(c.entity.newId)) continue;
    claimedWiki.add(c.wiki.wikiId);
    claimedNew.add(c.entity.newId);
    matched.set(c.wiki.wikiId, c);
  }

  const mappings: Mapping[] = wikiToMatch.map(wiki => {
    const m = matched.get(wiki.wikiId);

    if (!m) {
      return {
        wikiId: wiki.wikiId,
        oldExternalId: wiki.externalId,
        oldName: wiki.name,
        entityType: wiki.entityType,
        oldLatitude: wiki.latitude,
        oldLongitude: wiki.longitude,
        newExternalId: null,
        newName: null,
        confidence: 'unmatched' as const,
        confidenceScore: 0,
        distance: null,
        status: 'skip' as const,
      };
    }

    // "exact" is reserved for an unambiguous name hit — the reviewer can trust
    // those at a glance. Everything a coordinate carried stays "fuzzy" so it
    // gets looked at, however high it scored.
    const isExact = m.nameScore >= NAME_EXACT;

    return {
      wikiId: wiki.wikiId,
      oldExternalId: wiki.externalId,
      oldName: wiki.name,
      entityType: wiki.entityType,
      oldLatitude: wiki.latitude,
      oldLongitude: wiki.longitude,
      newExternalId: m.entity.newId,
      newName: m.entity.name,
      confidence: isExact ? ('exact' as const) : ('fuzzy' as const),
      confidenceScore: m.score,
      distance: m.distance !== null ? Math.round(m.distance) : null,
      status: 'confirmed' as const,
    };
  });

  // Sort: exact first, then fuzzy (best first), then unmatched
  const order: Record<MatchConfidence, number> = {exact: 0, fuzzy: 1, unmatched: 2};
  mappings.sort((a, b) =>
    order[a.confidence] - order[b.confidence] ||
    b.confidenceScore - a.confidenceScore,
  );

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
