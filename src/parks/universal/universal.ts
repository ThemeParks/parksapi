import {Destination, DestinationConstructor} from '../../destination.js';
import crypto from 'crypto';

import {cache} from '../../cache.js';
import {http, HTTPObj} from '../../http.js';
import {inject} from '../../injector.js';
import config from '../../config.js';

@config
class Universal extends Destination {
  @config
  secretKey: string = "";

  @config
  appKey: string = "";

  @config
  vQueueURL: string = "";

  @config
  baseURL: string = "";

  @config
  assetsBase: string = "";

  @config
  city: string = "orlando";

  constructor(options?: DestinationConstructor) {
    super(options);

    this.addConfigPrefix('UNIVERSALSTUDIOS');
  }

  @inject({
    eventName: 'httpRequest',
    hostname: 'services.universalorlando.com',
    // skip HTTP requests with apiKeyFetch tag
    tags: {
      $nin: ['apiKeyFetch']
    }
  })
  async injectAPIKey(requestObj: HTTPObj): Promise<string> {
    // get our API key
    const resp = await this.getAPIKey();

    // inject API key into request headers
    requestObj.headers = {
      ...requestObj.headers,
      'X-UNIWebService-ApiKey': this.appKey,
      'X-UNIWebService-Token': resp.apiKey,
    };

    return resp.apiKey;
  }

  // TODO - inject response and capture 401s to refresh token

  @cache({
    callback: (response) => {
      // Determine TTL based on response
      if (response && response.expiresIn) {
        return response.expiresIn;
      }
      return 60 * 60; // default to 1 hour
    }
  })
  async getAPIKey(): Promise<{
    apiKey: string, expiresIn: number
  }> {
    const resp = await this.fetchAPIKey();
    if (!resp.response || !resp.response.ok) {
      throw new Error(`Failed to fetch API key: ${resp.response?.status} ${resp.response?.statusText}`);
    }
    const respJson = await resp.json();

    const expireTime: number = respJson.TokenExpirationUnix; // token expiration timestamp in milliseconds
    // calculate time until expiration in seconds
    let tokenExpiration: number = (expireTime * 1000) - +new Date();
    // expire at least 5 minutes before actual expiration
    tokenExpiration = Math.max(tokenExpiration - (5 * 60 * 1000), 60 * 5 * 1000);

    const apiResponse = {
      apiKey: respJson.Token,
      expiresIn: Math.floor(tokenExpiration / 1000), // convert back to seconds
    };

    return apiResponse;
  }

  @http()
  async fetchAPIKey(): Promise<HTTPObj> {
    // create signature to get access token
    const now = new Date();
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const today = `${days[now.getUTCDay()]}, ${String(now.getUTCDate()).padStart(2, '0')} ${months[now.getUTCMonth()]} ${now.getUTCFullYear()} ${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}:${String(now.getUTCSeconds()).padStart(2, '0')} GMT`;
    const signatureBuilder = crypto.createHmac('sha256', this.secretKey);
    signatureBuilder.update(`${this.appKey}\n${today}\n`);
    // generate hash from signature builder
    //  also convert trailing equal signs to unicode. because. I don't know
    const signature = signatureBuilder.digest('base64').replace(/=$/, '\u003d');

    return {
      method: 'POST',
      url: `${this.baseURL}?city=${this.city}`,
      body: {
        apiKey: this.appKey,
        signature: signature,
      },
      headers: {
        'Date': today,
      },
      options: {
        json: true,
      },
      // mark this request with a tag so it doesn't trigger the injector again
      tags: ['apiKeyFetch']
    } as unknown as HTTPObj;
  }

  @http({
    validateResponse: {
      type: 'object',
      properties: {
        Results: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              Id: {type: 'number'}, // park ID
              ExternalIds: {
                type: 'object',
                properties: {
                  ContentId: {type: 'string'}, // park ID used in URLs
                },
                required: ['ContentId'],
              },
              MblDisplayName: {type: 'string'}, // park name
              AdmissionRequired: {type: 'boolean'}, // whether you need a ticket to enter
            },
            required: ['Id', 'ExternalIds', 'MblDisplayName', 'AdmissionRequired'],
          },
        },
      },
      required: ['Results'],
    }
  })
  async fetchParks(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseURL}/venues?city=${this.city}`,
      options: {
        json: true,
      },
    } as unknown as HTTPObj;
  }

  @cache({ttlSeconds: 60 * 60 * 3}) // cache for 3 hours
  async getParks() {
    const resp = await this.fetchParks();
    const data = await resp.json();
    return data.Results.filter((x: any) => {
      return x.AdmissionRequired;
    });
  }
}

// Universal Studios Orlando
export class UniversalOrlando extends Universal {
  constructor(...args: any[]) {
    super(...args);

    this.city = 'orlando';
  }
}

// Universal Studios Hollywood
export class UniversalStudios extends Universal {
  constructor(...args: any[]) {
    super(...args);

    this.city = 'hollywood';
  }
}

// Test harness as we build out the library
const park = new UniversalOrlando();

await park.getParks().then((parks) => {
  console.log('Fetched Parks:', parks.map((x : any) => {
    return {id: x.Id, name: x.MblDisplayName, contentId: x.ExternalIds.ContentId};
  }));
}).catch((err) => {
  console.error('Error fetching Parks:', err);
});

process.exit(0);
