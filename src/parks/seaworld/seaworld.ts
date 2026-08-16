/**
 * SeaWorld / Busch Gardens Parks TypeScript Implementation
 *
 * Supports 7 destinations covering all 12 parks the operator publishes:
 *  - SeaWorld Orlando (SeaWorld + Aquatica + Discovery Cove)
 *  - SeaWorld San Antonio (SeaWorld + Aquatica)
 *  - SeaWorld San Diego
 *  - Busch Gardens Tampa (Busch Gardens + Adventure Island)
 *  - Busch Gardens Williamsburg (Busch Gardens + Water Country USA)
 *  - Sesame Place Philadelphia
 *  - Sesame Place San Diego
 *
 * The full park list is enumerable at `v1/park/` (no path parameter), which
 * returns every park's UUID, brand and name. That is where the UUIDs below come
 * from, so a park added by the operator is discoverable rather than guessed —
 * check it before assuming a park has no feed.
 *
 * Not every park reports queues. The water parks (Adventure Island, both
 * Aquaticas, Water Country USA) and Discovery Cove return an empty `WaitTimes`
 * array while still publishing a full POI list and operating calendar, so they
 * are entity-and-schedule parks by design, not a broken join. Third-party
 * aggregators list wait times for some of them; the operator's own feed does
 * not carry any.
 *
 * API: base URL is config-only (`SEAWORLD_BASEURL`), no auth required.
 */

import {Destination, type DestinationConstructor} from '../../destination.js';
import config from '../../config.js';
import {http, type HTTPObj} from '../../http.js';
import {cache} from '../../cache.js';
import {destinationController} from '../../destinationRegistry.js';
import type {Entity, LiveData, EntitySchedule} from '@themeparks/typelib';
import {formatDate, localFromFakeUtc} from '../../datetime.js';

// ---------------------------------------------------------------------------
// API response types
// ---------------------------------------------------------------------------

type SeaworldPOIData = {
  Id: string;
  Name: string;
  Type: string;
  Coordinate?: {Latitude: number; Longitude: number};
  MinimumHeight?: string;
  ShowTimes?: unknown[];
};

type SeaworldParkDetail = {
  Id: string;
  park_Name: string;
  TimeZone: string;
  map_center?: {Latitude: number; Longitude: number};
  POIs: Record<string, SeaworldPOIData[]>;
  open_hours: Array<{
    opens_at: string;
    closes_at: string;
    date: string;
  }>;
};

type SeaworldAvailabilityResponse = {
  WaitTimes: Array<{
    Id: string;
    Minutes: number;
    Status: string;
    StatusDisplay: string | null;
    Title: string;
    LastUpDateTime: string;
  }>;
  ShowTimes: Array<{
    Id: string;
    ShowTimes: Array<{
      StartDateTime: string;
      EndDateTime: string;
      // Local time strings (no timezone suffix) — same value as StartDateTime/EndDateTime
      // minus the UTC offset.  The JS used StartTime/EndTime as local times.
      StartTime: string;
      EndTime: string;
    }>;
  }>;
};

/**
 * Decrement the date portion of a local ISO string by one day, preserving the
 * time-of-day and UTC offset (safe within a single DST season). Used to correct
 * a source glitch where closes_at is dated a day late.
 */
function rollDateBackOneDay(localIso: string): string {
  const tIdx = localIso.indexOf('T');
  const d = new Date(`${localIso.slice(0, tIdx)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  // utc-date-ok: the date half of a local ISO string, re-anchored at T00:00:00Z
  // purely to decrement it. The time and offset are carried over untouched.
  return d.toISOString().slice(0, 10) + localIso.slice(tIdx);
}

// ---------------------------------------------------------------------------
// Base class shared by all SeaWorld/Busch Gardens destinations
// ---------------------------------------------------------------------------

/**
 * SeaworldDestination is a shared base class for all SeaWorld and Busch
 * Gardens destinations. Subclasses specify which park UUIDs (resortIds) to
 * include, their timezone, and their destinationId.
 */
@config
export class SeaworldDestination extends Destination {
  // -------------------------------------------------------------------------
  // Config properties (loaded from env vars with SEAWORLD_ prefix)
  // -------------------------------------------------------------------------

  @config
  baseURL: string = '';

  @config
  appVersion: string = 'android-7.1.17.117525';

  // The list of park UUIDs for this destination (set by subclasses)
  resortIds: string[] = [];

  // Human-readable destination name (set by subclasses)
  destinationName: string = '';

  // Canonical ID used for this destination's entity (set by subclasses)
  destinationId: string = '';

  // IANA timezone for this destination (set by subclasses)
  timezone: string = 'America/New_York';

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('SEAWORLD');
  }

  // -------------------------------------------------------------------------
  // Cache key prefix — prevents cross-park cache collisions since all parks
  // share this base class and the same cached method names.
  // -------------------------------------------------------------------------
  getCacheKeyPrefix(): string {
    return `seaworld:${this.destinationId}`;
  }

  // -------------------------------------------------------------------------
  // HTTP fetch methods
  // -------------------------------------------------------------------------

  /**
   * Fetch detailed data for a single park UUID.
   * Cached for 12 hours — POIs and schedules rarely change.
   */
  @http({cacheSeconds: 12 * 60 * 60, retries: 2})
  async fetchParkDetail(parkId: string): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseURL}v1/park/${parkId}`,
      headers: {
        'user-agent': 'okhttp/4.12.0',
        'app_version': this.appVersion,
      },
      options: {json: true},
    } as any as HTTPObj;
  }

  /**
   * Fetch live availability data (wait times + show times) for a single park.
   * Cached for 1 minute.
   */
  @http({cacheSeconds: 60, retries: 2})
  async fetchAvailability(parkId: string, searchDate: string): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseURL}v1/park/${parkId}/availability/`,
      queryParams: {searchDate},
      headers: {
        'user-agent': 'okhttp/4.12.0',
        'app_version': this.appVersion,
      },
      options: {json: true},
    } as any as HTTPObj;
  }

  // -------------------------------------------------------------------------
  // Cached data retrieval methods
  // -------------------------------------------------------------------------

  /**
   * Get detailed park data for a single park UUID.
   */
  @cache({ttlSeconds: 12 * 60 * 60})
  async getParkDetail(parkId: string): Promise<SeaworldParkDetail> {
    const resp = await this.fetchParkDetail(parkId);
    return await resp.json();
  }

  /**
   * Get live availability for a single park UUID.
   */
  @cache({ttlSeconds: 60})
  async getAvailability(parkId: string, searchDate: string): Promise<SeaworldAvailabilityResponse> {
    const resp = await this.fetchAvailability(parkId, searchDate);
    return await resp.json();
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Collect all POIs from all groups in the park detail, filtered by the
   * supplied Type values.  The JS code iterates all groups because some POIs
   * can appear in the "wrong" group.
   */
  private getAllPoisOfTypes(
    parkDetail: SeaworldParkDetail,
    types: string[],
  ): SeaworldPOIData[] {
    const pois: SeaworldPOIData[] = [];
    for (const group of Object.values(parkDetail.POIs)) {
      for (const poi of group) {
        if (types.includes(poi.Type)) {
          pois.push(poi);
        }
      }
    }
    return pois;
  }

  /**
   * Today's date in the PARK's timezone, YYYY-MM-DD, for use as searchDate.
   *
   * Must not be the UTC date. UTC is 4-7h ahead of the US parks, so from 20:00
   * Eastern (17:00 Pacific) the UTC date has already rolled over and we would
   * ask the API for tomorrow while the park is still open — precisely the
   * window when summer nights, Howl-O-Scream and other ticketed evening events
   * run. searchDate selects which day's ShowTimes come back, so the evening
   * schedule would be replaced by the next day's.
   *
   * The app agrees: DefaultAvailabilityRepository sends
   * `LocalDate.now().toString()`, i.e. the device-local date.
   */
  private getTodayDateString(): string {
    return formatDate(new Date(), this.timezone);
  }

  /**
   * Is this park within its published operating hours right now?
   *
   * Needed because the feed's "no reading" state (Minutes < 0 with a blank
   * Status) carries no information about whether a ride is running, and the
   * right reading flips with the clock. Overnight the feed drops EVERY ride to
   * that state with no closure marker at all — a 02:16 local sample had all 17
   * SeaWorld Orlando rides there — so treating it as OPERATING unconditionally
   * would show a shut park's rides as open all night.
   *
   * Every published block counts, including ticketed evening events: the park
   * is operating for whoever holds that ticket, and a ride running during a
   * summer-nights session is not closed.
   *
   * Returns false when nothing covers the current moment. That is deliberately
   * indistinguishable from "shut" at the call site, because the conservative
   * reading is the same either way, but the two cases that are NOT ordinary
   * closures get a warning so they are visible in logs rather than silently
   * flipping a park's unmeasured rides to CLOSED at midday.
   */
  private isParkOpenNow(parkDetail: SeaworldParkDetail, nowMs: number = Date.now()): boolean {
    if (!parkDetail?.open_hours || parkDetail.open_hours.length === 0) {
      console.warn(`[${this.constructor.name}] no operating hours published; treating unmeasured rides as closed`);
      return false;
    }

    const todayLocal = formatDate(new Date(nowMs), this.timezone);
    let sawToday = false;

    for (const oh of parkDetail.open_hours) {
      const openingTime = localFromFakeUtc(oh.opens_at, this.timezone);
      let closingTime = localFromFakeUtc(oh.closes_at, this.timezone);
      // Same source-glitch guard as buildSchedules: a closes_at dated a day
      // late produces an impossible 34-35h span, which would otherwise report
      // the park open right through the night.
      if (new Date(closingTime).getTime() - new Date(openingTime).getTime() > 25 * 60 * 60 * 1000) {
        closingTime = rollDateBackOneDay(closingTime);
      }
      const open = new Date(openingTime).getTime();
      const close = new Date(closingTime).getTime();
      if (!Number.isFinite(open) || !Number.isFinite(close)) continue;
      // No explicit guard for an inverted span (closes_at dated a day early,
      // the mirror of the >25h case): the half-open test below cannot match an
      // empty interval, so such a block is skipped naturally. An extra check
      // would be unreachable by any observable behaviour.
      if (openingTime.slice(0, 10) === todayLocal) sawToday = true;
      if (nowMs >= open && nowMs < close) return true;
    }

    if (!sawToday) {
      console.warn(
        `[${this.constructor.name}] operating hours contain no block for ${todayLocal}; ` +
        `treating unmeasured rides as closed`
      );
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Destination entity (optional override for custom names)
  // -------------------------------------------------------------------------

  async getDestinations(): Promise<Entity[]> {
    // Build location from the first park's map_center
    let location: {latitude: number; longitude: number} | undefined;
    if (this.resortIds.length > 0) {
      try {
        const firstPark = await this.getParkDetail(this.resortIds[0]);
        if (firstPark.map_center) {
          location = {
            latitude: firstPark.map_center.Latitude,
            longitude: firstPark.map_center.Longitude,
          };
        }
      } catch {
        // ignore — location is optional
      }
    }

    return [
      {
        id: this.destinationId,
        name: this.destinationName,
        entityType: 'DESTINATION',
        timezone: this.timezone,
        ...(location ? {location} : {}),
      } as Entity,
    ];
  }

  // -------------------------------------------------------------------------
  // Template Method: buildEntityList
  // -------------------------------------------------------------------------

  protected async buildEntityList(): Promise<Entity[]> {
    const entities: Entity[] = [];

    // Destination
    entities.push(...await this.getDestinations());

    // Parks, Attractions, Shows, Restaurants
    //
    // Deliberately NOT wrapped in a per-park try/catch (unlike buildLiveData).
    // The collector diffs this list against the live API and issues
    // `DELETE v1/entity/<id>` for anything present remotely but missing here.
    // Swallowing a fetch failure would emit a partial list and delete every
    // entity of the failed park from the wiki — far worse than the outage it
    // would be papering over. Throwing aborts the sync and changes nothing.
    for (const parkId of this.resortIds) {
      const parkDetail = await this.getParkDetail(parkId);

      // --- PARK entity ---
      const parkEntity: Entity = {
        id: parkDetail.Id,
        name: parkDetail.park_Name,
        entityType: 'PARK',
        parentId: this.destinationId,
        destinationId: this.destinationId,
        timezone: this.timezone,
      };
      if (parkDetail.map_center) {
        parkEntity.location = {
          latitude: parkDetail.map_center.Latitude,
          longitude: parkDetail.map_center.Longitude,
        };
      }
      entities.push(parkEntity);

      // --- ATTRACTIONs (Rides + Slides + Pools) ---
      // `Pools` is the water parks' own type for wave pools, lazy rivers and
      // activity lagoons — the headline attractions at a park whose only other
      // rideable type is `Slides`. Leaving it out cost Discovery Cove every
      // attraction it has (it lists no Rides or Slides at all) and stripped the
      // signature item from each water park. Cabanas, Services, Restrooms and
      // Shops stay out: those are amenities, not attractions.
      const rides = this.getAllPoisOfTypes(parkDetail, ['Rides', 'Slides', 'Pools']);
      for (const poi of rides) {
        const entity: Entity = {
          id: poi.Id,
          name: poi.Name,
          entityType: 'ATTRACTION',
          attractionType: 'RIDE',
          parentId: parkDetail.Id,
          destinationId: this.destinationId,
          timezone: this.timezone,
        };
        if (poi.Coordinate) {
          entity.location = {
            latitude: poi.Coordinate.Latitude,
            longitude: poi.Coordinate.Longitude,
          };
        }
        entities.push(entity);
      }

      // --- SHOWs ---
      const shows = this.getAllPoisOfTypes(parkDetail, ['Shows']);
      for (const poi of shows) {
        const entity: Entity = {
          id: poi.Id,
          name: poi.Name,
          entityType: 'SHOW',
          parentId: parkDetail.Id,
          destinationId: this.destinationId,
          timezone: this.timezone,
        };
        if (poi.Coordinate) {
          entity.location = {
            latitude: poi.Coordinate.Latitude,
            longitude: poi.Coordinate.Longitude,
          };
        }
        entities.push(entity);
      }

      // --- RESTAURANTs (Dining) ---
      const dining = this.getAllPoisOfTypes(parkDetail, ['Dining']);
      for (const poi of dining) {
        const entity: Entity = {
          id: poi.Id,
          name: poi.Name,
          entityType: 'RESTAURANT',
          parentId: parkDetail.Id,
          destinationId: this.destinationId,
          timezone: this.timezone,
        };
        if (poi.Coordinate) {
          entity.location = {
            latitude: poi.Coordinate.Latitude,
            longitude: poi.Coordinate.Longitude,
          };
        }
        entities.push(entity);
      }
    }

    return entities;
  }

  // -------------------------------------------------------------------------
  // Template Method: buildLiveData
  // -------------------------------------------------------------------------

  protected async buildLiveData(): Promise<LiveData[]> {
    const liveDataMap = new Map<string, LiveData>();
    const searchDate = this.getTodayDateString();

    // Note the CLOSED default: it is only ever observable for a SHOW that has
    // no showtimes today, which is the correct reading for a show. Every
    // wait-time branch below assigns a status explicitly, so a ride can never
    // fall through to this default — do not rely on `continue` to leave a ride
    // unset, as that silently republishes it as CLOSED.
    const getOrCreate = (id: string): LiveData => {
      let entry = liveDataMap.get(id);
      if (!entry) {
        entry = {id, status: 'CLOSED'};
        liveDataMap.set(id, entry);
      }
      return entry;
    };

    for (const parkId of this.resortIds) {
      // Isolate per-park failures. Every park in this destination shares one
      // upstream, so an unguarded throw here loses live data for the whole
      // family: a single 403 on Discovery Cove would take SeaWorld Orlando and
      // Aquatica down with it. src/http.ts treats 4xx as non-retryable
      // (correctly — a rejection is definitive, and retrying a bot-protection
      // block in-cycle just adds load), so the throw arrives immediately.
      // Skipping omits this park's rows for this cycle only; the next cycle
      // retries from scratch. Sibling parks keep reporting.
      //
      // buildEntityList/buildSchedules deliberately do NOT do this — see the
      // comment on their loops.
      let availability: SeaworldAvailabilityResponse;
      let parkIsOpen: boolean | null = null;
      try {
        availability = await this.getAvailability(parkId, searchDate);
        // Operating hours decide how to read the "no reading" state below.
        // Cached 12h, so this is normally free. A failure here must not cost us
        // the live data we already have: fall back to parkIsOpen = null, which
        // takes the conservative branch.
        try {
          parkIsOpen = this.isParkOpenNow(await this.getParkDetail(parkId));
        } catch (err: any) {
          console.warn(
            `[${this.constructor.name}] operating hours unavailable for park ${parkId}, ` +
            `treating unmeasured rides as closed: ${err?.message ?? err}`
          );
        }
      } catch (err: any) {
        console.warn(
          `[${this.constructor.name}] live data unavailable for park ${parkId}, ` +
          `skipping it this cycle: ${err?.message ?? err}`
        );
        continue;
      }

      // --- Wait times ---
      //
      // The feed carries three states, not two. `Minutes: -1` alone does NOT
      // mean closed; it is the sentinel for "no value", and `Status` is what
      // separates a real closure from an absent reading:
      //
      //   Status non-empty          -> genuinely closed, text says why
      //   Minutes >= 0              -> operating, real wait time
      //   Minutes < 0, Status empty -> upstream has no current reading
      //
      // This matches the vendor app's own parser, which discards the entire
      // wait-time object when minutes are negative AND status is blank
      // (PoiAvailabilityEntityMapper.checkWaitTimeNull), then renders the ride
      // normally with no wait badge. It never shows such a ride as closed.
      //
      // Mapping the third case to CLOSED (the previous behaviour) was wrong for
      // 59 of 122 rides family-wide, and it also swallowed real closures: a ride
      // already published as CLOSED shows no change at the moment it actually
      // closes, so the event never reaches consumers.
      //
      // Test `Status` generically rather than matching known strings. A 41-round
      // census saw three ("Closed Temporarily", "Closed For The Day", "Closed Due
      // To Weather"), and the newest was the most frequent — the set is open.
      for (const wt of (availability.WaitTimes || [])) {
        if (!wt.Id) continue;
        const entry = getOrCreate(wt.Id);

        // Either field carries the closure text; StatusDisplay is null when
        // absent. Coerce with String() before trimming: a non-string here would
        // throw, and this loop sits outside the per-park try above, so one
        // malformed row would take down every park in the destination and undo
        // the isolation that block exists to provide.
        //
        // Trim each field separately rather than `a || b`. A whitespace-only
        // Status is truthy, so it would win the || and then trim to empty,
        // discarding a real closure sitting in StatusDisplay.
        const closureText = String(wt.Status ?? '').trim() || String(wt.StatusDisplay ?? '').trim();

        // Only trust an actual number. Number() maps null, '', '  ' and [] to 0,
        // which is finite and >= 0, so coercing here would invent a walk-on out
        // of an absent field. The base-class sanitiser cannot catch that either,
        // because 0 is a perfectly valid wait time.
        const minutes = typeof wt.Minutes === 'number' ? wt.Minutes : NaN;

        if (closureText) {
          entry.status = 'CLOSED';
          entry.queue = {STANDBY: {waitTime: null}};
        } else if (Number.isFinite(minutes) && minutes >= 0) {
          entry.status = 'OPERATING';
          entry.queue = {STANDBY: {waitTime: minutes}};
        } else {
          // No reading available, so the feed tells us nothing about this ride
          // and the operating hours decide the reading. Open: the ride is
          // presumed running, we simply have no wait time. Shut (or unknown):
          // closed, which is also the safe default — overnight every ride lands
          // here with no closure marker, and claiming OPERATING would show a
          // shut park as open.
          //
          // Either way waitTime is null, never undefined: the queue exists and
          // does produce values later (observed: rides sat unmeasured for
          // hours, then reported a real wait), which is exactly the schema's
          // "queue exists but no current value is available". Omitting `queue`
          // would instead claim the entity has no queue at all.
          entry.status = parkIsOpen ? 'OPERATING' : 'CLOSED';
          entry.queue = {STANDBY: {waitTime: null}};
        }
      }

      // --- Show times ---
      for (const st of (availability.ShowTimes || [])) {
        if (!st.Id) continue;
        const entry = getOrCreate(st.Id);

        if (st.ShowTimes && st.ShowTimes.length > 0) {
          entry.status = 'OPERATING';
          entry.showtimes = st.ShowTimes.map((time) => {
            // StartTime/EndTime are local datetime strings without a timezone
            // suffix (e.g. "2026-04-01T12:00:00").  Use constructDateTime to
            // attach the correct offset for this destination's timezone.
            const startLocal = localFromFakeUtc(time.StartTime, this.timezone);
            const endLocal = localFromFakeUtc(time.EndTime, this.timezone);
            return {
              startTime: startLocal,
              endTime: endLocal,
              type: 'Performance',
            };
          });
        }
      }
    }

    // Post-process: mark attractions with "Closed" in their name as
    // refurbishment if they have no live data yet (matches JS behaviour).
    try {
      const entities = await this.buildEntityList();
      const attractions = entities.filter(e => e.entityType === 'ATTRACTION');
      for (const attraction of attractions) {
        if (!liveDataMap.has(attraction.id)) {
          const name = typeof attraction.name === 'string'
            ? attraction.name
            : Object.values(attraction.name as Record<string, string>)[0] || '';
          if (name.includes('Closed')) {
            liveDataMap.set(attraction.id, {
              id: attraction.id,
              status: 'REFURBISHMENT',
            });
          }
        }
      }
    } catch {
      // ignore — entity list failure should not block live data
    }

    return Array.from(liveDataMap.values());
  }

  // -------------------------------------------------------------------------
  // Template Method: buildSchedules
  // -------------------------------------------------------------------------

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    const schedules: EntitySchedule[] = [];

    // Also deliberately un-isolated, for the same reason as buildEntityList:
    // a partial schedule set silently drops a park's operating hours rather
    // than reporting them as unknown. Both loops read the same 12h-cached
    // getParkDetail, so a transient upstream failure is usually absorbed by
    // the cache before it ever reaches here.
    for (const parkId of this.resortIds) {
      const parkDetail = await this.getParkDetail(parkId);
      if (!parkDetail.open_hours || parkDetail.open_hours.length === 0) continue;

      // On event days the API returns a second open_hours block for the SAME
      // date — the park's daytime session (e.g. 9:00–19:30) plus a separate
      // ticketed event (evening "summer nights" 20:00–23:00, a pre-opening
      // early-entry event, or an overnight event). The blocks are type-less, so
      // emitting them all as OPERATING makes the event masquerade as (or
      // overwrite) the normal operating hours. There is no event flag on the
      // hours entries and the /events endpoint is a noisy mixed list (festivals,
      // shows, private events) that doesn't reliably map to a block — so classify
      // by time of day: the block overlapping core midday IS the operating
      // session; every other same-date block is a TICKETED_EVENT. Robust to
      // events that open before OR after normal hours (unlike "earliest block").
      const byDate = new Map<string, Array<{openingTime: string; closingTime: string}>>();
      for (const oh of parkDetail.open_hours) {
        const openingTime = localFromFakeUtc(oh.opens_at, this.timezone);
        let closingTime = localFromFakeUtc(oh.closes_at, this.timezone);
        // Source-glitch guard: on some event days the API dates closes_at a day
        // late, producing impossible 34–35h "operating" spans. No real session or
        // event runs >25h, so roll the close back one day. Legit past-midnight
        // event closes (e.g. 20:00→01:00, ~5h) stay well under the threshold.
        if (new Date(closingTime).getTime() - new Date(openingTime).getTime() > 25 * 60 * 60 * 1000) {
          closingTime = rollDateBackOneDay(closingTime);
        }
        const date = openingTime.slice(0, 10);
        const entries = byDate.get(date);
        if (entries) entries.push({openingTime, closingTime});
        else byDate.set(date, [{openingTime, closingTime}]);
      }

      // Local minutes-since-midnight from a "…THH:MM…" ISO string.
      const minsOfDay = (iso: string) =>
        parseInt(iso.slice(11, 13), 10) * 60 + parseInt(iso.slice(14, 16), 10);
      const MIDDAY_START = 12 * 60; // 12:00 local
      const MIDDAY_END = 16 * 60; //   16:00 local

      const schedule = [];
      for (const [date, entries] of byDate) {
        const spans = entries.map((e) => {
          const open = minsOfDay(e.openingTime);
          // Next-day close (crosses midnight) rolls the close minutes past 24h.
          const close =
            minsOfDay(e.closingTime) + (e.closingTime.slice(0, 10) > date ? 24 * 60 : 0);
          return {...e, open, close};
        });
        // Operating session = block(s) overlapping the midday window. Events
        // (early-morning, evening, overnight) don't reach it. Fall back to the
        // longest block if none overlaps (e.g. an evening-event-only day) so a
        // day never loses its operating hours entirely.
        let operating = spans.filter((s) => s.open < MIDDAY_END && s.close > MIDDAY_START);
        if (operating.length === 0 && spans.length > 0) {
          operating = [spans.reduce((a, b) => (b.close - b.open > a.close - a.open ? b : a))];
        }
        const operatingSet = new Set(operating);
        for (const s of spans) {
          schedule.push({
            date,
            openingTime: s.openingTime,
            closingTime: s.closingTime,
            type: operatingSet.has(s) ? ('OPERATING' as const) : ('TICKETED_EVENT' as const),
          });
        }
      }

      schedules.push({
        id: parkDetail.Id,
        schedule,
      });
    }

    return schedules;
  }
}

// ---------------------------------------------------------------------------
// Concrete destination classes
// ---------------------------------------------------------------------------

/**
 * SeaWorld Parks and Resorts Orlando
 * Includes: SeaWorld Orlando + Aquatica Orlando + Discovery Cove Orlando
 *
 * Discovery Cove is appended rather than inserted: `getDestinations()` takes the
 * destination's coordinates from `resortIds[0]`, so reordering this array would
 * silently move the destination pin to a different park.
 */
@destinationController({category: 'SeaWorld'})
export class SeaworldOrlando extends SeaworldDestination {
  constructor(options?: DestinationConstructor) {
    super(options);
    this.resortIds = [
      'AC3AF402-3C62-4893-8B05-822F19B9D2BC', // SeaWorld Orlando
      '4B040706-968A-41B4-9967-D93C7814E665', // Aquatica Orlando
      '1FB04DFC-B6C0-4918-BE36-EE6DD14FE741', // Discovery Cove Orlando
    ];
    this.timezone = 'America/New_York';
    this.destinationName = 'SeaWorld Parks and Resorts Orlando';
    this.destinationId = 'seaworldorlandoresort';
  }
}

/**
 * SeaWorld San Antonio
 * Includes: SeaWorld San Antonio + Aquatica San Antonio
 */
@destinationController({category: 'SeaWorld'})
export class SeaworldSanAntonio extends SeaworldDestination {
  constructor(options?: DestinationConstructor) {
    super(options);
    this.resortIds = [
      'F4040D22-8B8D-4394-AEC7-D05FA5DEA945', // SeaWorld San Antonio
      '04668F50-A57E-4DE6-8E70-D4567D9B46B5', // Aquatica San Antonio
    ];
    this.timezone = 'America/Chicago';
    this.destinationName = 'SeaWorld San Antonio';
    this.destinationId = 'seaworldsanantonio';
  }
}

/**
 * SeaWorld San Diego
 */
@destinationController({category: 'SeaWorld'})
export class SeaworldSanDiego extends SeaworldDestination {
  constructor(options?: DestinationConstructor) {
    super(options);
    this.resortIds = [
      '4325312F-FDF1-41FF-ABF4-361A4FF03443',
    ];
    this.timezone = 'America/Los_Angeles';
    this.destinationName = 'SeaWorld San Diego';
    this.destinationId = 'seaworldsandiego';
  }
}

/**
 * Busch Gardens Tampa
 * Includes: Busch Gardens Tampa + Adventure Island Tampa
 */
@destinationController({category: 'Busch Gardens'})
export class BuschGardensTampa extends SeaworldDestination {
  constructor(options?: DestinationConstructor) {
    super(options);
    this.resortIds = [
      'C001866B-555D-4E92-B48E-CC67E195DE96', // Busch Gardens Tampa
      '770E691C-E6DA-4264-AF27-863189380D0B', // Adventure Island Tampa
    ];
    this.timezone = 'America/New_York';
    this.destinationName = 'Busch Gardens Tampa';
    this.destinationId = 'buschgardenstampa';
  }
}

/**
 * Busch Gardens Williamsburg
 * Includes: Busch Gardens Williamsburg + Water Country USA
 *
 * Note: destinationId preserves legacy typo "willamsburg" (one 'l') for
 * backwards compatibility with the JS implementation.
 */
@destinationController({category: 'Busch Gardens'})
export class BuschGardensWilliamsburg extends SeaworldDestination {
  constructor(options?: DestinationConstructor) {
    super(options);
    this.resortIds = [
      '45FE1F31-D4E4-4B1E-90E0-5255111070F2', // Busch Gardens Williamsburg
      '66480532-A73C-4617-9B2D-EDC4430CAB86', // Water Country USA
    ];
    this.timezone = 'America/New_York';
    this.destinationName = 'Busch Gardens Williamsburg';
    this.destinationId = 'buschgardenswillamsburg';
  }
}

/**
 * Sesame Place Philadelphia
 *
 * The API still calls this park "Sesame Place Langhorne" (its town), which is
 * what the PARK entity is named, while the park has traded publicly as Sesame
 * Place Philadelphia since 2021. The destination carries the public brand so it
 * is findable under the name guests use.
 *
 * Reports real queues: 17 ride rows, 9 of them carrying a live reading during a
 * midday sample.
 */
@destinationController({category: 'Sesame Place'})
export class SesamePlacePhiladelphia extends SeaworldDestination {
  constructor(options?: DestinationConstructor) {
    super(options);
    this.resortIds = [
      'F7408854-28CB-4B1E-98E5-4449FE600E85', // Sesame Place Langhorne
    ];
    this.timezone = 'America/New_York';
    this.destinationName = 'Sesame Place Philadelphia';
    this.destinationId = 'sesameplacephiladelphia';
  }
}

/**
 * Sesame Place San Diego
 *
 * Publishes a `WaitTimes` array covering all 7 rides. A full operating day of
 * sampling found every entry at the `Minutes: -1` sentinel with an empty
 * `Status`, i.e. "no current reading" rather than closed. That is not peculiar
 * to this park — it is the most common state family-wide (45% of observations)
 * — but this park is the extreme, being the only one where no ride produced a
 * reading all day.
 *
 * The base class maps that state to OPERATING with a null standby wait time, so
 * this park correctly shows its rides as open with no wait data, instead of the
 * seven all-day CLOSED rows it published before.
 */
@destinationController({category: 'Sesame Place'})
export class SesamePlaceSanDiego extends SeaworldDestination {
  constructor(options?: DestinationConstructor) {
    super(options);
    this.resortIds = [
      'A988F4CE-6A81-4527-9535-DDB378689E52', // Sesame Place San Diego
    ];
    this.timezone = 'America/Los_Angeles';
    this.destinationName = 'Sesame Place San Diego';
    this.destinationId = 'sesameplacesandiego';
  }
}
