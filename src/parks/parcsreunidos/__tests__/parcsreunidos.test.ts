import {describe, test, expect, vi, beforeEach, afterEach} from 'vitest';
import {MovieParkGermany} from '../parcsreunidos.js';
import {CacheLib} from '../../../cache.js';
import type {HTTPObj} from '../../../http.js';

/**
 * The Stay-App bearer is a shared, app-embedded service-account credential
 * (OAuth2 password grant against a Keycloak realm) that deliberately isn't
 * stored in this repo. It's fetched from an external token service instead
 * — see src/tokenService.ts — the same pattern GentingSkyworlds uses for its
 * VQ bearer.
 */
describe('ParcsReunidosDestination.injectHeaders — token-service credential', () => {
  const ENV_KEYS = ['MOVIEPARKGERMANY_TOKENURL', 'MOVIEPARKGERMANY_TOKENAUTH', 'MOVIEPARKGERMANY_TOKENAUTHHEADER'];
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    CacheLib.clear();
    for (const k of ENV_KEYS) delete process.env[k];
    fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({accessToken: 'STAYAPP_TOK', exp: 4102444800000}),
    }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of ENV_KEYS) delete process.env[k];
    CacheLib.clear();
  });

  test('injects the fetched bearer and the Stay-Establishment header', async () => {
    process.env.MOVIEPARKGERMANY_TOKENURL = 'https://token.example/stayapp';
    const park = new MovieParkGermany();
    park.stayEstablishment = 'mBv6';

    const req = {headers: {}} as HTTPObj;
    await park.injectHeaders(req);

    expect(req.headers!['Authorization']).toBe('Bearer STAYAPP_TOK');
    expect(req.headers!['Stay-Establishment']).toBe('mBv6');
  });

  test('sends tokenAuth under a custom tokenAuthHeader when configured', async () => {
    process.env.MOVIEPARKGERMANY_TOKENURL = 'https://token.example/stayapp';
    process.env.MOVIEPARKGERMANY_TOKENAUTH = 'secret-abc';
    process.env.MOVIEPARKGERMANY_TOKENAUTHHEADER = 'x-custom-key';

    await new MovieParkGermany().injectHeaders({headers: {}} as HTTPObj);

    const [, opts] = fetchMock.mock.calls[0] as [string, any];
    expect(opts.headers['x-custom-key']).toBe('secret-abc');
  });

  test('omits Authorization entirely when tokenUrl is unset, rather than sending a malformed empty Bearer', async () => {
    const req = {headers: {}} as HTTPObj;
    await new MovieParkGermany().injectHeaders(req);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(req.headers).not.toHaveProperty('Authorization');
    expect(req.headers!['Stay-Establishment']).toBe('');
  });

  test('two Parcs Reunidos parks pointed at the same tokenUrl share one cached fetch', async () => {
    process.env.MOVIEPARKGERMANY_TOKENURL = 'https://token.example/shared-stayapp';

    await new MovieParkGermany().injectHeaders({headers: {}} as HTTPObj);
    await new MovieParkGermany().injectHeaders({headers: {}} as HTTPObj);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
