import {Destination, DestinationConstructor} from '../../destination.js';
import config from '../../config.js';
import {cache} from '../../cache.js';
import {http, HTTPObj} from '../../http.js';
import {destinationController} from '../../destinationRegistry.js';
import {constructDateTime, formatInTimezone, shiftDateString} from '../../datetime.js';
import {AttractionTypeEnum, type Entity, type EntitySchedule, type LiveData, type ScheduleEntry} from '@themeparks/typelib';

interface HelpyPoint {
  id: string;
  nome: string;
  categoria: string;
  descrizione?: string;
  lat?: number | string;
  lng?: number | string;
}

interface HelpyShow {
  id: string;
  infoPointId?: string;
  pointId?: string;
  placeId?: string;
  parco?: string;
  schedule?: Record<string, string[]>;
}

const DESTINATION_ID = 'canevaworld-resort';
const PARK_ID = 'movieland';

/** Movieland's schedule page, relative to the CanevaWorld website origin. */
const CALENDAR_PATH = 'calendario-orari-prezzi.html';
/** The page's calendar widget fetches its per-month data from here. */
const CALENDAR_DATA_PATH = 'bootstrap/template_calendar_data';
/** Widget instance on the Movieland schedule page. Caneva Aquapark uses others. */
const CALENDAR_ID = '3';
/** The widget's booking context. Unset on a read-only calendar page. */
const CALENDAR_CONTEXT = '0';

export function movielandEntityId(id: string): string {
  return id.normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/[^\w.-]/g, '_');
}

export function movielandShowtimes(
  shows: HelpyShow[],
  pointIds: Set<string>,
  date: string,
  timezone: string,
): LiveData[] {
  const result = shows.flatMap(show => {
    const id = [show.id, show.infoPointId]
      .filter((candidate): candidate is string => !!candidate)
      .map(movielandEntityId)
      .find(candidate => pointIds.has(candidate));
    if (!id) return [];

    const showtimes = (show.schedule?.[date] ?? [])
      .filter(time => /^([01]\d|2[0-3]):[0-5]\d$/.test(time))
      .map(startTime => ({type: 'Performance', startTime: constructDateTime(date, startTime, timezone)}));

    return showtimes.length ? [{id, status: 'OPERATING', showtimes} as LiveData] : [];
  });
  const merged = new Map<string, LiveData>();
  for (const entry of result) {
    const existing = merged.get(entry.id);
    if (existing) existing.showtimes?.push(...entry.showtimes ?? []);
    else merged.set(entry.id, entry);
  }
  for (const entry of merged.values()) entry.showtimes?.sort((a, b) => (a.startTime ?? '').localeCompare(b.startTime ?? ''));
  return [...merged.values()];
}

/**
 * One entry of the calendar's colour legend.
 *
 * The site paints each day of the calendar with a "content" id and puts the
 * human-readable hours in a legend keyed by that same id, so a day is only
 * meaningful once both halves are joined.
 */
export interface MovielandLegendEntry {
  /** Opening time, HH:mm, absent on a closed day. */
  openingTime?: string;
  /** Closing time, HH:mm. "24.00" is normalised to "00:00" on the next day. */
  closingTime?: string;
  /** True when the closing time belongs to the following calendar day. */
  closesNextDay?: boolean;
  /** The event this day belongs to, e.g. "Halloween Night". Absent on a plain day. */
  description?: string;
  /** True for an explicitly closed day. */
  closed?: boolean;
}

/** Shape of GET bootstrap/template_calendar_data/{ctx}/{id}/{year}/{month}. */
export interface MovielandCalendarMonth {
  /**
   * content-calendar id -> YYYY-MM-DD -> content id -> metadata.
   *
   * Sibling `prev_month` / `next_month` keys carry the same shape for the
   * neighbouring months. Reading those too would silently publish another
   * month's hours, so only this key is ever walked.
   */
  contents_calendars?: Record<string, Record<string, Record<string, unknown>>>;
}

/** "Chiuso" (it), "Closed" (en), "Geschlossen" (de) - the three languages the site publishes. */
const CLOSED_LABEL = /^\s*(chius[oa]|closed|geschlossen)\s*$/i;

/** The site writes hours as either "10:00 - 19:00" or "10.00 - 24.00". */
const HOURS = /(\d{1,2})[.:](\d{2})\s*[-–]\s*(\d{1,2})[.:](\d{2})/;

/**
 * The long legend label prefixes plain days with "Orari apertura:" and event
 * days with the event's own name ("Movy Night | ...", "Halloween Night ...").
 * Only the second kind is a description worth publishing, so the boilerplate
 * is stripped in the three languages the site renders.
 */
const HOURS_BOILERPLATE = /^\s*(orari?o?\s+(di\s+)?apertura|opening\s+(hours|times?)|(\u00d6|Oe)ffnungszeiten)\s*$/i;

/**
 * Parse the calendar's legend out of the schedule page.
 *
 * Each legend element carries `data-cid` plus two renderings of the same
 * information: `.f3` is the long form the tooltip shows ("Halloween Night
 * 10.00 - 24.00"), `.f6` the short form painted into the day cell
 * ("10.00 - 24.00"). The long form is parsed for hours *and* event name and
 * the short form is the fallback, because a few entries carry the event name
 * only in the long form.
 *
 * Legend entries that are neither a time range nor an explicit closure are
 * dropped: the same legend markup is reused for marketing tiles ("Buy a
 * ticket for Movieland!") that never appear in the calendar data.
 */
export function parseMovielandLegend(html: string): Record<string, MovielandLegendEntry> {
  const legend: Record<string, MovielandLegendEntry> = {};
  const blocks = html.matchAll(/data-cid="(\d+)"([\s\S]*?)(?=data-cid="|$)/g);

  for (const [, cid, body] of blocks) {
    const text = (pattern: RegExp): string | undefined => {
      const found = body.match(pattern);
      if (!found) return undefined;
      return found[1]
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    };
    const long = text(/<div class="fieldvalue f3">([\s\S]*?)<\/div>/);
    const short = text(/fieldvalue f6[^>]*>([\s\S]*?)<\/div>/);

    if ([long, short].some(label => label && CLOSED_LABEL.test(label))) {
      legend[cid] = {closed: true};
      continue;
    }

    const hours = (long && long.match(HOURS)) || (short && short.match(HOURS));
    if (!hours) continue;

    const [, openHour, openMinute, closeHour, closeMinute] = hours;
    // 24:00 is the site's spelling of midnight; ISO has no such hour, so it
    // becomes 00:00 on the following day.
    const closesNextDay = Number(closeHour) >= 24;
    const label = long?.replace(HOURS, '').replace(/[|:,\s]+$/, '').replace(/^[|:,\s]+/, '').trim();
    const description = label && !HOURS_BOILERPLATE.test(label) ? label : undefined;

    legend[cid] = {
      openingTime: `${openHour.padStart(2, '0')}:${openMinute}`,
      closingTime: closesNextDay ? `${String(Number(closeHour) - 24).padStart(2, '0')}:${closeMinute}` : `${closeHour.padStart(2, '0')}:${closeMinute}`,
      ...(closesNextDay ? {closesNextDay} : {}),
      ...(description ? {description} : {}),
    };
  }

  return legend;
}

/** The park's published season, read from the calendar widget's own bounds. */
export function parseMovielandSeason(html: string): {min?: string; max?: string} {
  const bounds = (attribute: string): string | undefined => {
    const found = html.match(new RegExp(`${attribute}="(\\d{2})/(\\d{2})/(\\d{4})"`));
    return found ? `${found[3]}-${found[2]}-${found[1]}` : undefined;
  };
  return {min: bounds('data-min-date'), max: bounds('data-max-date')};
}

/**
 * Join one month of calendar data to the legend and produce schedule entries.
 *
 * Closed days are omitted rather than published: the schedule contract has no
 * CLOSED type, and every other park in this repo skips them.
 */
export function movielandScheduleEntries(
  month: MovielandCalendarMonth,
  legend: Record<string, MovielandLegendEntry>,
  timezone: string,
): ScheduleEntry[] {
  const entries: ScheduleEntry[] = [];

  // Only the top-level key. `prev_month`/`next_month` hold neighbouring months.
  for (const days of Object.values(month.contents_calendars ?? {})) {
    for (const [date, contents] of Object.entries(days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

      for (const cid of Object.keys(contents)) {
        const entry = legend[cid];
        if (!entry || entry.closed || !entry.openingTime || !entry.closingTime) continue;

        entries.push({
          date,
          type: 'OPERATING',
          openingTime: constructDateTime(date, entry.openingTime, timezone),
          closingTime: constructDateTime(
            entry.closesNextDay ? shiftDateString(date, 1) : date,
            entry.closingTime,
            timezone,
          ),
          ...(entry.description ? {description: entry.description} : {}),
        } as ScheduleEntry);
        break; // one set of hours per day
      }
    }
  }

  entries.sort((a, b) => a.date.localeCompare(b.date));
  return entries;
}

/**
 * The calendar months a schedule fetch should cover, starting at `year`/`month`
 * inclusive. `month` is 1-based, matching the endpoint.
 *
 * The unit is a whole month because that is the unit the endpoint serves: a
 * fetch of the current month returns its past days too, and they are published
 * as-is rather than trimmed to today.
 */
export function movielandMonthsToFetch(year: number, month: number, count: number): Array<{year: number; month: number}> {
  return Array.from({length: count}, (_, offset) => {
    const zeroBased = month - 1 + offset;
    return {year: year + Math.floor(zeroBased / 12), month: (zeroBased % 12) + 1};
  });
}

@destinationController({category: 'Canevaworld'})
export class Movieland extends Destination {
  @config baseURL = '';
  @config timezone = 'Europe/Rome';

  /**
   * Origin of the CanevaWorld website, which publishes the opening calendar
   * the Helpy app feed does not carry. Empty by default: with no origin
   * configured buildSchedules() stays a no-op rather than guessing a host.
   */
  @config webBase = '';

  /** How many calendar months to publish, counting the current one. */
  @config scheduleMonths = 4;

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('MOVIELAND');
  }

  @http({cacheSeconds: 86400})
  async fetchPoints(): Promise<HTTPObj> {
    return {method: 'GET', url: `${this.baseURL}/points_movieland.json`, options: {json: true}} as HTTPObj;
  }

  @http({cacheSeconds: 300})
  async fetchShows(): Promise<HTTPObj> {
    return {method: 'GET', url: `${this.baseURL}/shows.it.json`, options: {json: true}} as HTTPObj;
  }

  /**
   * The schedule page. Carries the colour legend (the actual opening hours)
   * and the season bounds; the day-to-colour mapping comes from
   * fetchCalendarMonth().
   *
   * The site refuses parksapi's own HTTP client, so this 403s unless the
   * caller supplies a client that it accepts (see calendarPageUrl). Parsing
   * lives here either way; with no webBase configured getSchedules() is a
   * no-op, so the default build never calls this at all.
   */
  /**
   * URL of the schedule page.
   *
   * Public because a caller that has to fetch this with its own HTTP client
   * (see fetchCalendarPage) must build the same URL rather than keeping a
   * second copy of the path that can drift from this one.
   */
  calendarPageUrl(): string {
    return `${this.webBase}/${CALENDAR_PATH}`;
  }

  /** URL of one month of calendar data. Months are 1-based. */
  calendarMonthUrl(year: number, month: number): string {
    return `${this.webBase}/${CALENDAR_DATA_PATH}/${CALENDAR_CONTEXT}/${CALENDAR_ID}/${year}/${month}`;
  }

  @http({cacheSeconds: 43200, retries: 1})
  async fetchCalendarPage(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: this.calendarPageUrl(),
      options: {json: false},
      tags: ['website'],
    } as HTTPObj;
  }

  /** One month of the opening calendar. Months are 1-based. */
  @http({cacheSeconds: 43200, retries: 1})
  async fetchCalendarMonth(year: number, month: number): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: this.calendarMonthUrl(year, month),
      options: {json: true},
      tags: ['website'],
    } as HTTPObj;
  }

  @cache({ttlSeconds: 43200})
  async getCalendarLegend(): Promise<Record<string, MovielandLegendEntry>> {
    const html = await (await this.fetchCalendarPage()).text();
    const season = parseMovielandSeason(html);
    const today = formatInTimezone(new Date(), this.timezone, 'date').split('/');
    if (season.max && season.max < `${today[2]}-${today[0]}-${today[1]}`) {
      // Not an error: the site publishes one season at a time and the park is
      // genuinely shut. Worth a line, because an empty schedule after this
      // date means "season over", not "parser broke".
      console.warn(`Movieland: published season ended ${season.max}, no hours to publish until the site rolls over`);
    }
    return parseMovielandLegend(html);
  }

  @cache({ttlSeconds: 86400})
  async getPoints(): Promise<HelpyPoint[]> {
    return await (await this.fetchPoints()).json();
  }

  async getDestinations(): Promise<Entity[]> {
    return [{
      id: DESTINATION_ID,
      name: 'Canevaworld Resort',
      entityType: 'DESTINATION',
      timezone: this.timezone,
      location: {latitude: 45.4768, longitude: 10.7262},
    } as Entity];
  }

  protected async buildEntityList(): Promise<Entity[]> {
    const points = await this.getPoints();
    const park = {
      id: PARK_ID,
      name: 'Movieland The Hollywood Park',
      entityType: 'PARK',
      parentId: DESTINATION_ID,
      destinationId: DESTINATION_ID,
      timezone: this.timezone,
      location: {latitude: 45.4768, longitude: 10.7262},
    } as Entity;

    const entities = points.flatMap(point => {
      const entityType = point.categoria === 'ride' ? 'ATTRACTION'
        : point.categoria === 'show' ? 'SHOW'
          : point.categoria === 'food' ? 'RESTAURANT' : undefined;
      if (!entityType) return [];

      const latitude = point.lat === '' || point.lat == null ? NaN : Number(point.lat);
      const longitude = point.lng === '' || point.lng == null ? NaN : Number(point.lng);
      return [{
        id: movielandEntityId(point.id),
        name: point.nome,
        entityType,
        ...(entityType === 'ATTRACTION' ? {attractionType: AttractionTypeEnum.RIDE} : {}),
        parentId: PARK_ID,
        destinationId: DESTINATION_ID,
        timezone: this.timezone,
        ...(point.descrizione ? {description: point.descrizione} : {}),
        ...(Number.isFinite(latitude) && Number.isFinite(longitude) ? {location: {latitude, longitude}} : {}),
      } as Entity];
    });

    return [park, ...entities];
  }

  protected async buildLiveData(): Promise<LiveData[]> {
    const [points, response] = await Promise.all([this.getPoints(), this.fetchShows().catch(() => null)]);
    if (!response) return [];
    const shows = await response.json() as HelpyShow[];
    const today = formatInTimezone(new Date(), this.timezone, 'date').split('/');
    const date = `${today[2]}-${today[0]}-${today[1]}`;
    return movielandShowtimes(shows.filter(show => show.parco === 'movieland'), new Set(points.filter(p => p.categoria === 'show').map(p => movielandEntityId(p.id))), date, this.timezone);
  }

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    if (!this.webBase) return [];

    const legend = await this.getCalendarLegend();
    if (!Object.keys(legend).length) {
      throw new Error('Movieland: calendar legend parsed empty, refusing to publish hours without it');
    }

    const [month, , year] = formatInTimezone(new Date(), this.timezone, 'date').split('/').map(Number);

    const months = await Promise.all(
      movielandMonthsToFetch(year, month, this.scheduleMonths).map(async ({year, month}) => {
        const data = await (await this.fetchCalendarMonth(year, month)).json() as MovielandCalendarMonth;
        return movielandScheduleEntries(data, legend, this.timezone);
      }),
    );

    const schedule = months.flat();
    return schedule.length ? [{id: PARK_ID, schedule}] : [];
  }
}
