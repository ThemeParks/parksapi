import {Destination, DestinationConstructor} from '../../destination.js';
import {cache, CacheLib} from '../../cache.js';
import {http, HTTPObj} from '../../http.js';
import {inject} from '../../injector.js';
import config from '../../config.js';
import {destinationController} from '../../destinationRegistry.js';
import {Entity, LiveData, EntitySchedule} from '@themeparks/typelib';
import {decodeHtmlEntities} from '../../htmlUtils.js';

const TOKEN_CACHE_KEY = 'flamingoland:idToken';
const DESTINATION_ID = 'flamingoland';
const PARK_ID = 'flamingoland-park';

type FsValue = {
  stringValue?: string;
  integerValue?: string;
  doubleValue?: number;
  booleanValue?: boolean;
  nullValue?: null;
  arrayValue?: {values?: FsValue[]};
  mapValue?: {fields?: Record<string, FsValue>};
  referenceValue?: string;
  timestampValue?: string;
};

type FsDoc = {
  name: string;
  fields?: Record<string, FsValue>;
};

function fsString(v?: FsValue): string | undefined {
  return v?.stringValue;
}
function fsBool(v?: FsValue): boolean | undefined {
  return v?.booleanValue;
}
function fsInt(v?: FsValue): number | undefined {
  if (v?.integerValue !== undefined) return Number(v.integerValue);
  if (v?.doubleValue !== undefined) return v.doubleValue;
  return undefined;
}

@destinationController({category: 'Flamingo Land'})
export class FlamingoLand extends Destination {
  @config apiKey: string = '';
  @config projectId: string = '';
  @config androidPackage: string = '';
  @config androidCert: string = '';
  @config email: string = '';
  @config password: string = '';
  @config timezone: string = 'Europe/London';

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('FLAMINGOLAND');
  }

  private get firestoreBase(): string {
    return `https://firestore.googleapis.com/v1/projects/${this.projectId}/databases/(default)/documents`;
  }

  private get identityBase(): string {
    return 'https://identitytoolkit.googleapis.com/v1/accounts';
  }

  // ===== Authentication =====

  @cache({ttlSeconds: 60 * 50, key: TOKEN_CACHE_KEY})
  async getIdToken(): Promise<string> {
    if (!this.email || !this.password) {
      throw new Error('Flamingo Land requires FLAMINGOLAND_EMAIL and FLAMINGOLAND_PASSWORD to be set');
    }

    // Try sign-in first, fall back to sign-up if the account does not exist yet.
    let resp = await this.fetchSignIn(this.email, this.password);
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      const code = err?.error?.message;
      if (code === 'EMAIL_NOT_FOUND') {
        resp = await this.fetchSignUp(this.email, this.password);
      }
    }
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data?.idToken) {
      throw new Error(`Flamingo Land auth failed: ${resp.status} ${JSON.stringify(data)}`);
    }
    return String(data.idToken);
  }

  @http({retries: 1})
  async fetchSignIn(email: string, password: string): Promise<HTTPObj> {
    return {
      method: 'POST',
      url: `${this.identityBase}:signInWithPassword?key=${this.apiKey}`,
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({email, password, returnSecureToken: true}),
      options: {json: false},
      tags: ['auth'],
    } as any as HTTPObj;
  }

  @http({retries: 1})
  async fetchSignUp(email: string, password: string): Promise<HTTPObj> {
    return {
      method: 'POST',
      url: `${this.identityBase}:signUp?key=${this.apiKey}`,
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({email, password, returnSecureToken: true}),
      options: {json: false},
      tags: ['auth'],
    } as any as HTTPObj;
  }

  // ===== Injectors =====

  @inject({
    eventName: 'httpRequest',
    hostname: {$in: ['firestore.googleapis.com', 'identitytoolkit.googleapis.com']},
  } as any)
  async injectAndroidClientHeaders(req: HTTPObj): Promise<void> {
    if (!this.androidPackage || !this.androidCert) return;
    req.headers = {
      ...req.headers,
      'X-Android-Package': this.androidPackage,
      'X-Android-Cert': this.androidCert,
    };
  }

  @inject({
    eventName: 'httpRequest',
    hostname: 'firestore.googleapis.com',
    tags: {$nin: ['auth']},
    priority: 1,
  } as any)
  async injectAuthToken(req: HTTPObj): Promise<void> {
    const token = await this.getIdToken();
    req.headers = {
      ...req.headers,
      'authorization': `Bearer ${token}`,
    };
  }

  @inject({
    eventName: 'httpError',
    hostname: 'firestore.googleapis.com',
    tags: {$nin: ['auth']},
  } as any)
  async handleUnauthorized(req: HTTPObj): Promise<void> {
    const status = req.response?.status;
    if (status !== 401 && status !== 403) return;
    CacheLib.delete(TOKEN_CACHE_KEY);
    req.response = undefined as any;
  }

  // ===== HTTP Fetches =====

  @http({cacheSeconds: 60, retries: 2})
  async fetchCollectionPage(collection: string, pageToken: string | null): Promise<HTTPObj> {
    const params = new URLSearchParams({key: this.apiKey, pageSize: '300'});
    if (pageToken) params.set('pageToken', pageToken);
    return {
      method: 'GET',
      url: `${this.firestoreBase}/${collection}?${params.toString()}`,
      options: {json: true},
    } as any as HTTPObj;
  }

  private async readCollection(collection: string): Promise<FsDoc[]> {
    const out: FsDoc[] = [];
    let pageToken: string | null = null;
    // Firestore paginates — loop until exhausted. 300 per page matches app behaviour.
    // Small collections (all of Flamingo Land's data is <100 docs) mean usually a single page.
    for (let i = 0; i < 20; i++) {
      const resp = await this.fetchCollectionPage(collection, pageToken);
      const data = await resp.json();
      if (data?.documents) out.push(...(data.documents as FsDoc[]));
      pageToken = data?.nextPageToken || null;
      if (!pageToken) break;
    }
    return out;
  }

  @cache({ttlSeconds: 60})
  async getRides(): Promise<FsDoc[]> {
    return this.readCollection('rides_data');
  }

  @cache({ttlSeconds: 3600})
  async getRideCategories(): Promise<FsDoc[]> {
    return this.readCollection('ride_categories');
  }

  // ===== Entities =====

  async getDestinations(): Promise<Entity[]> {
    return [{
      id: DESTINATION_ID,
      name: 'Flamingo Land Resort',
      entityType: 'DESTINATION',
      timezone: this.timezone,
      location: {latitude: 54.21112, longitude: -0.80845},
    } as Entity];
  }

  protected async buildEntityList(): Promise<Entity[]> {
    const [rides, categories] = await Promise.all([this.getRides(), this.getRideCategories()]);

    const parkEntity: Entity = {
      id: PARK_ID,
      name: 'Flamingo Land',
      entityType: 'PARK',
      parentId: DESTINATION_ID,
      destinationId: DESTINATION_ID,
      timezone: this.timezone,
      location: {latitude: 54.21112, longitude: -0.80845},
    } as Entity;

    // Category lookup to skip non-theme-park entries (e.g. zoo animals) in future.
    // Current ride_categories: 16 Thrill, 17 Family, 19 Kids (all showQueueTime=true),
    // 20 Getting Around, 135 Other Attractions (showQueueTime=false).
    // We keep rows from all ride categories — non-tracked ones still emit status.
    const validCategoryIds = new Set<number>();
    for (const cat of categories) {
      const id = fsInt(cat.fields?.id);
      if (id !== undefined) validCategoryIds.add(id);
    }

    const attractions: Entity[] = [];
    for (const doc of rides) {
      const id = doc.name.split('/').pop() || '';
      const title = fsString(doc.fields?.title);
      const catId = fsInt(doc.fields?.categoriesId);
      if (!id || !title) continue;
      if (catId !== undefined && validCategoryIds.size > 0 && !validCategoryIds.has(catId)) continue;

      attractions.push({
        id,
        name: decodeHtmlEntities(title),
        entityType: 'ATTRACTION',
        parentId: PARK_ID,
        parkId: PARK_ID,
        destinationId: DESTINATION_ID,
        timezone: this.timezone,
      } as Entity);
    }

    return [parkEntity, ...attractions];
  }

  // ===== Live Data =====

  protected async buildLiveData(): Promise<LiveData[]> {
    const [rides, categories] = await Promise.all([this.getRides(), this.getRideCategories()]);

    // Only rides whose category has showQueueTime=true emit waitTime; others are status-only.
    const queueCategories = new Set<number>();
    for (const cat of categories) {
      if (fsBool(cat.fields?.showQueueTime)) {
        const id = fsInt(cat.fields?.id);
        if (id !== undefined) queueCategories.add(id);
      }
    }

    const out: LiveData[] = [];
    for (const doc of rides) {
      const id = doc.name.split('/').pop() || '';
      const title = fsString(doc.fields?.title);
      if (!id || !title) continue;

      const statusOpen = fsBool(doc.fields?.statusOpen) ?? false;
      const underMaintenance = fsBool(doc.fields?.underMaintenance) ?? false;
      const downAllDay = fsBool(doc.fields?.downAllDay) ?? false;
      const catId = fsInt(doc.fields?.categoriesId);

      let status: LiveData['status'];
      if (underMaintenance) status = 'REFURBISHMENT';
      else if (downAllDay || !statusOpen) status = 'CLOSED';
      else status = 'OPERATING';

      const ld: LiveData = {id, status} as LiveData;

      if (status === 'OPERATING' && catId !== undefined && queueCategories.has(catId)) {
        const wt = fsInt(doc.fields?.queue_time);
        if (wt !== undefined && Number.isFinite(wt)) {
          ld.queue = {STANDBY: {waitTime: wt}};
        }
      }

      out.push(ld);
    }
    return out;
  }

  // ===== Schedules =====

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    // No schedule feed found in-app. The website has a calendar but no public JSON.
    // Leaving empty for now — rides.latest_ride_time analogue does not exist here.
    return [{id: PARK_ID, schedule: []} as EntitySchedule];
  }
}
