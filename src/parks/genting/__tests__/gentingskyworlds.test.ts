import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { GentingSkyworlds } from '../gentingskyworlds.js';
import { CacheLib } from '../../../cache.js';

/**
 * The VQ bearer is fetched from an external token service. Some services expect
 * the credential in a header other than `Authorization`, so `tokenAuthHeader`
 * makes the header name configurable (default `Authorization`, backward-compat).
 */
describe('GentingSkyworlds.getAccessToken — token-service credential header', () => {
    const ENV_KEYS = [
        'GENTINGSKYWORLDS_TOKENURL',
        'GENTINGSKYWORLDS_TOKENAUTH',
        'GENTINGSKYWORLDS_TOKENAUTHHEADER',
    ];
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        CacheLib.clear();
        for (const k of ENV_KEYS) delete process.env[k];
        fetchMock = vi.fn(async () => ({
            ok: true,
            json: async () => ({ accessToken: 'TOK123', exp: 4102444800000 }),
        }));
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        for (const k of ENV_KEYS) delete process.env[k];
        CacheLib.clear();
    });

    test('sends tokenAuth under a custom tokenAuthHeader when configured', async () => {
        process.env.GENTINGSKYWORLDS_TOKENURL = 'https://token.example/a';
        process.env.GENTINGSKYWORLDS_TOKENAUTH = 'secret-abc';
        process.env.GENTINGSKYWORLDS_TOKENAUTHHEADER = 'x-custom-key';

        const token = await new GentingSkyworlds().getAccessToken();

        expect(token).toBe('TOK123');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, opts] = fetchMock.mock.calls[0] as [string, any];
        expect(url).toBe('https://token.example/a');
        expect(opts.headers['x-custom-key']).toBe('secret-abc');
        expect(opts.headers).not.toHaveProperty('Authorization');
    });

    test('defaults to the Authorization header when tokenAuthHeader is unset (backward compatible)', async () => {
        process.env.GENTINGSKYWORLDS_TOKENURL = 'https://token.example/b';
        process.env.GENTINGSKYWORLDS_TOKENAUTH = 'secret-def';

        await new GentingSkyworlds().getAccessToken();

        const [, opts] = fetchMock.mock.calls[0] as [string, any];
        expect(opts.headers['Authorization']).toBe('secret-def');
    });

    test('sends no credential header when tokenAuth is empty', async () => {
        process.env.GENTINGSKYWORLDS_TOKENURL = 'https://token.example/c';

        await new GentingSkyworlds().getAccessToken();

        const [, opts] = fetchMock.mock.calls[0] as [string, any];
        expect(opts.headers).not.toHaveProperty('Authorization');
        expect(Object.keys(opts.headers)).toEqual(['Accept']);
    });
});
