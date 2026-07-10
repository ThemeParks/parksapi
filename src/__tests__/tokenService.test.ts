import {describe, test, expect, vi, beforeEach, afterEach} from 'vitest';
import {fetchExternalToken} from '../tokenService.js';
import {CacheLib} from '../cache.js';

describe('fetchExternalToken', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    CacheLib.clear();
    fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({accessToken: 'TOK123', exp: 4102444800000}),
    }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    CacheLib.clear();
  });

  test('returns empty string when tokenUrl is unset', async () => {
    const token = await fetchExternalToken({tokenUrl: ''});
    expect(token).toBe('');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('fetches and returns accessToken from the configured URL', async () => {
    const token = await fetchExternalToken({tokenUrl: 'https://token.example/a'});
    expect(token).toBe('TOK123');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://token.example/a');
  });

  test('sends tokenAuth under a custom tokenAuthHeader when configured', async () => {
    await fetchExternalToken({
      tokenUrl: 'https://token.example/b',
      tokenAuth: 'secret-abc',
      tokenAuthHeader: 'x-custom-key',
    });
    const [, opts] = fetchMock.mock.calls[0] as [string, any];
    expect(opts.headers['x-custom-key']).toBe('secret-abc');
    expect(opts.headers).not.toHaveProperty('Authorization');
  });

  test('defaults to the Authorization header when tokenAuthHeader is unset', async () => {
    await fetchExternalToken({tokenUrl: 'https://token.example/c', tokenAuth: 'secret-def'});
    const [, opts] = fetchMock.mock.calls[0] as [string, any];
    expect(opts.headers['Authorization']).toBe('secret-def');
  });

  test('sends no credential header when tokenAuth is empty', async () => {
    await fetchExternalToken({tokenUrl: 'https://token.example/d'});
    const [, opts] = fetchMock.mock.calls[0] as [string, any];
    expect(opts.headers).not.toHaveProperty('Authorization');
    expect(Object.keys(opts.headers)).toEqual(['Accept']);
  });

  test('caches successful results — a second call for the same tokenUrl does not re-fetch', async () => {
    await fetchExternalToken({tokenUrl: 'https://token.example/e'});
    await fetchExternalToken({tokenUrl: 'https://token.example/e'});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('two different destinations pointed at the same tokenUrl share one cached fetch', async () => {
    const [a, b] = await Promise.all([
      fetchExternalToken({tokenUrl: 'https://token.example/shared', logPrefix: '[ParkA]'}),
      fetchExternalToken({tokenUrl: 'https://token.example/shared', logPrefix: '[ParkB]'}),
    ]);
    expect(a).toBe('TOK123');
    expect(b).toBe('TOK123');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('returns empty string and does not cache on a non-OK HTTP response', async () => {
    fetchMock.mockResolvedValueOnce({ok: false, status: 503, json: async () => ({})});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const first = await fetchExternalToken({tokenUrl: 'https://token.example/f'});
    expect(first).toBe('');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('token service HTTP 503'));

    const second = await fetchExternalToken({tokenUrl: 'https://token.example/f'});
    expect(second).toBe('TOK123');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    warnSpy.mockRestore();
  });

  test('returns empty string when the response has no accessToken', async () => {
    fetchMock.mockResolvedValueOnce({ok: true, json: async () => ({})});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const token = await fetchExternalToken({tokenUrl: 'https://token.example/g', logPrefix: '[TestPark]'});

    expect(token).toBe('');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[TestPark]'));
    warnSpy.mockRestore();
  });
});
