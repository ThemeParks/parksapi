import {Destination, DestinationConstructor} from '../../destination.js';
import config from '../../config.js';
import {cache} from '../../cache.js';
import {http, HTTPObj} from '../../http.js';
import {destinationController} from '../../destinationRegistry.js';
import {constructDateTime, formatInTimezone} from '../../datetime.js';
import {AttractionTypeEnum, type Entity, type EntitySchedule, type LiveData} from '@themeparks/typelib';

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

@destinationController({category: 'Canevaworld'})
export class Movieland extends Destination {
  @config baseURL = '';
  @config timezone = 'Europe/Rome';

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
    // CanevaWorld blocks server-side calendar requests with Cloudflare and has
    // no official static schedule source available to this integration.
    return [];
  }
}
