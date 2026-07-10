import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { GentingSkyworlds } from '../gentingskyworlds.js';
import { CacheLib } from '../../../cache.js';

/**
 * getAccessToken() is a thin delegation to the shared fetchExternalToken()
 * helper (see src/tokenService.ts and its own test suite for header-shape /
 * caching coverage). These tests only need to prove the delegation itself
 * is wired correctly — that Genting's config properties and identity
 * actually reach the shared helper — not re-verify its internals.
 */
describe('GentingSkyworlds.getAccessToken — delegates to the shared token service', () => {
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

    test('forwards tokenUrl/tokenAuth/tokenAuthHeader and returns the fetched token', async () => {
        process.env.GENTINGSKYWORLDS_TOKENURL = 'https://token.example/a';
        process.env.GENTINGSKYWORLDS_TOKENAUTH = 'secret-abc';
        process.env.GENTINGSKYWORLDS_TOKENAUTHHEADER = 'x-custom-key';

        const token = await new GentingSkyworlds().getAccessToken();

        expect(token).toBe('TOK123');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, opts] = fetchMock.mock.calls[0] as [string, any];
        expect(url).toBe('https://token.example/a');
        expect(opts.headers['x-custom-key']).toBe('secret-abc');
    });

    test('caches under a GentingSkyworlds-specific key, reachable via CacheLib.clearByClassName', async () => {
        process.env.GENTINGSKYWORLDS_TOKENURL = 'https://token.example/b';

        await new GentingSkyworlds().getAccessToken();
        expect(fetchMock).toHaveBeenCalledTimes(1);

        const cleared = CacheLib.clearByClassName('GentingSkyworlds');
        expect(cleared).toBeGreaterThan(0);

        await new GentingSkyworlds().getAccessToken();
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    test('forwards the [GentingSkyworlds] log prefix on failure', async () => {
        process.env.GENTINGSKYWORLDS_TOKENURL = 'https://token.example/c';
        fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const token = await new GentingSkyworlds().getAccessToken();

        expect(token).toBe('');
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[GentingSkyworlds]'));
        warnSpy.mockRestore();
    });
});
