import {Destination, DestinationConstructor} from '../../destination.js';
import crypto from 'crypto';

import {cache} from '../../cache.js';
import {http, HTTPObj} from '../../http.js';
import {inject} from '../../injector.js';
import config from '../../config.js';
import {destinationController} from '../../destinationRegistry.js';
import {
  Entity,
  LiveData,
  EntitySchedule,
  LanguageCode,
} from '@themeparks/typelib';
import {formatUTC, parseTimeInTimezone, formatInTimezone, addDays, isBefore} from '../../datetime.js';
import {TagBuilder} from '../../tags/index.js';

@config
@destinationController({ category: 'Efteling' })
export class Efteling extends Destination {
  @config
  apiKey: string = '';

  @config
  apiVersion: string = '9';

  @config
  appVersion: string = 'v5.18.0';

  @config
  timezone: string = 'Europe/Amsterdam';

  @config
  language: LanguageCode = 'nl';

  deviceId: string;

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('EFTELING');
    this.deviceId = crypto.randomUUID();
  }

  /**
   * Inject headers into all HTTP requests for api.efteling.com
   */
  @inject({
    eventName: 'httpRequest',
    hostname: 'api.efteling.com',
  })
  async injectApiHeaders(requestObj: HTTPObj): Promise<void> {
    requestObj.headers = {
      ...requestObj.headers,
      'x-api-key': this.apiKey,
      'x-api-version': this.apiVersion,
      'x-app-version': this.appVersion,
      'x-app-name': 'Efteling',
      'x-app-id': 'nl.efteling.android',
      'x-app-platform': 'Android',
      'x-app-language': requestObj.headers?.['x-app-language'] || 'en',
      'x-app-timezone': 'Europe/Amsterdam',
      'x-app-deviceid': this.deviceId,
      'user-agent': 'okhttp/5.1.0',
    };
  }

  /**
   * Inject headers into all HTTP requests for www.efteling.com
   */
  @inject({
    eventName: 'httpRequest',
    hostname: 'www.efteling.com',
  })
  async injectCalendarHeaders(requestObj: HTTPObj): Promise<void> {
    requestObj.headers = {
      ...requestObj.headers,
      'X-Requested-With': 'XMLHttpRequest',
      'referer': 'https://www.efteling.com/en/park/opening-hours?app=true',
      'cookie': 'website#lang=en',
    };
  }

  async getDestinations(): Promise<Entity[]> {
    return [{
      id: 'eftelingresort',
      name: { en: 'Efteling', nl: 'Efteling' },
      entityType: 'DESTINATION',
      timezone: 'Europe/Amsterdam',
      location: { latitude: 51.649515, longitude: 5.043776 },
    } as Entity];
  }

  protected async buildEntityList(): Promise<Entity[]> {
    return [];
  }

  protected async buildLiveData(): Promise<LiveData[]> {
    return [];
  }

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    return [];
  }
}
