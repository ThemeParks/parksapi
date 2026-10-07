import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { GentingSkyworlds } from '../gentingskyworlds.js';
import { CacheLib, MethodCacheHit, setMethodCacheObserver } from '../../../cache.js';
import { setHttpTransport, HttpCaller, HttpRequestOptions } from '../../../httpProxy.js';

/**
 * The VQ bearer is fetched from an external token service through
 * `makeHttpRequest()`, so the HTTP transport sees the request and can answer
 * it, which is also how these tests keep off the network. Some services
 * expect the credential in a header other than `Authorization`, so
 * `tokenAuthHeader` makes the header name configurable (default
 * `Authorization`, backward-compat).
 */
describe('GentingSkyworlds.getAccessToken — the token-service request', () => {
    const ENV_KEYS = [
        'GENTINGSKYWORLDS_TOKENURL',
        'GENTINGSKYWORLDS_TOKENAUTH',
        'GENTINGSKYWORLDS_TOKENAUTHHEADER',
    ];
    let seen: Array<{ request: HttpRequestOptions; caller: HttpCaller }>;

    function tokenService(status = 200) {
        return async (request: HttpRequestOptions, caller: HttpCaller) => {
            seen.push({ request, caller });
            return new Response(JSON.stringify({ accessToken: 'TOK123', exp: 4102444800000 }), {
                status,
                headers: { 'content-type': 'application/json' },
            });
        };
    }

    beforeEach(() => {
        CacheLib.clear();
        for (const k of ENV_KEYS) delete process.env[k];
        seen = [];
        setHttpTransport(tokenService());
    });

    afterEach(() => {
        setHttpTransport(null);
        for (const k of ENV_KEYS) delete process.env[k];
        CacheLib.clear();
    });

    test('sends tokenAuth under a custom tokenAuthHeader when configured', async () => {
        process.env.GENTINGSKYWORLDS_TOKENURL = 'https://token.example/a';
        process.env.GENTINGSKYWORLDS_TOKENAUTH = 'secret-abc';
        process.env.GENTINGSKYWORLDS_TOKENAUTHHEADER = 'x-custom-key';

        const token = await new GentingSkyworlds().getAccessToken();

        expect(token).toBe('TOK123');
        expect(seen).toHaveLength(1);
        const [{ request }] = seen;
        expect(request.method).toBe('GET');
        expect(request.url).toBe('https://token.example/a');
        expect(request.headers!['x-custom-key']).toBe('secret-abc');
        expect(request.headers).not.toHaveProperty('Authorization');
    });

    test('defaults to the Authorization header when tokenAuthHeader is unset (backward compatible)', async () => {
        process.env.GENTINGSKYWORLDS_TOKENURL = 'https://token.example/b';
        process.env.GENTINGSKYWORLDS_TOKENAUTH = 'secret-def';

        await new GentingSkyworlds().getAccessToken();

        expect(seen[0].request.headers!['Authorization']).toBe('secret-def');
    });

    test('sends no credential header when tokenAuth is empty', async () => {
        process.env.GENTINGSKYWORLDS_TOKENURL = 'https://token.example/c';

        await new GentingSkyworlds().getAccessToken();

        const { headers } = seen[0].request;
        expect(headers).not.toHaveProperty('Authorization');
        expect(Object.keys(headers!).sort()).toEqual(['Accept', 'accept-encoding', 'user-agent']);
    });

    test('reaches the HTTP transport with its caller, and caches the token', async () => {
        process.env.GENTINGSKYWORLDS_TOKENURL = 'https://token.example/d';
        const park = new GentingSkyworlds();

        expect(await park.getAccessToken()).toBe('TOK123');
        expect(await park.getAccessToken()).toBe('TOK123');

        expect(seen).toHaveLength(1);
        expect(seen[0].caller).toMatchObject({ className: 'GentingSkyworlds', methodName: 'getAccessToken' });
    });

    test('reports the cached token to the method cache observer with its caller, not the token or the URL', async () => {
        // tokenUrl is configuration and can carry a credential, so neither the
        // key nor the caller an observer is handed may carry it.
        const tokenUrl = 'https://user:url-password@token.example/f?api_key=url-secret';
        process.env.GENTINGSKYWORLDS_TOKENURL = tokenUrl;
        const hits: MethodCacheHit[] = [];
        setMethodCacheObserver((hit) => { hits.push(hit); });
        try {
            const park = new GentingSkyworlds();
            await park.getAccessToken();
            await park.getAccessToken();

            expect(seen).toHaveLength(1);
            expect(hits).toHaveLength(1);
            expect(hits[0].key).toMatch(/^GentingSkyworlds:accessToken:[0-9a-f]{16}$/);
            expect(hits[0].caller).toEqual({ className: 'GentingSkyworlds', methodName: 'getAccessToken', instanceId: seen[0].caller.instanceId });

            const reported = JSON.stringify(hits[0]);
            for (const secret of ['TOK123', 'url-secret', 'url-password', 'token.example', tokenUrl]) {
                expect(reported).not.toContain(secret);
            }
        } finally {
            setMethodCacheObserver(null);
        }
    });

    test('keeps the token service URL out of the stored cache key', async () => {
        process.env.GENTINGSKYWORLDS_TOKENURL = 'https://token.example/g?api_key=url-secret';

        await new GentingSkyworlds().getAccessToken();

        const keys = CacheLib.keys().filter((key) => key.includes('accessToken'));
        expect(keys).toHaveLength(1);
        expect(keys[0]).toMatch(/^GentingSkyworlds:accessToken:[0-9a-f]{16}$/);
    });

    test('asks again when the token service URL changes, and not when it comes back', async () => {
        const park = () => new GentingSkyworlds();

        process.env.GENTINGSKYWORLDS_TOKENURL = 'https://token.example/one';
        await park().getAccessToken();
        process.env.GENTINGSKYWORLDS_TOKENURL = 'https://token.example/two';
        await park().getAccessToken();

        // A new URL must not be served the old URL's token.
        expect(seen.map((s) => s.request.url)).toEqual(['https://token.example/one', 'https://token.example/two']);

        // Each URL keeps its own entry, so going back to the first is a hit.
        process.env.GENTINGSKYWORLDS_TOKENURL = 'https://token.example/one';
        await park().getAccessToken();
        expect(seen).toHaveLength(2);
    });

    test('returns an empty string when the token service fails, and asks again next time', async () => {
        process.env.GENTINGSKYWORLDS_TOKENURL = 'https://token.example/e';
        setHttpTransport(tokenService(503));
        const park = new GentingSkyworlds();

        expect(await park.getAccessToken()).toBe('');
        expect(await park.getAccessToken()).toBe('');

        expect(seen).toHaveLength(2);
    });

    test('makes no request without a tokenUrl', async () => {
        expect(await new GentingSkyworlds().getAccessToken()).toBe('');
        expect(seen).toHaveLength(0);
    });
});
