/**
 * Regression test for `src/httpProxy.ts` mutual-TLS plumbing.
 *
 * If `makeHttpRequest` pairs Node's *global* `fetch` (which is backed
 * by Node's bundled undici) with an `Agent` constructed from the
 * npm-installed undici, the two undici copies' Dispatcher interceptor
 * contracts can diverge and undici throws
 *   "invalid onRequestStart method"
 * at request start. The fix is to import `fetch` from `undici` so both
 * halves of the dispatcher contract come from the same module copy.
 *
 * We don't need a working TLS handshake to catch this — the failure
 * fires at the very start of the request, before the socket is opened.
 * Pointing at an unroutable address with cert/key set is enough: a
 * connect error is fine; the interceptor-mismatch error is the failure.
 */
import {describe, test, expect, afterAll} from 'vitest';
import {makeHttpRequest} from '../httpProxy.js';
import {stopHttpQueue} from '../http.js';

afterAll(() => {
  stopHttpQueue();
});

// Inline self-signed PEMs are awkward to assemble in pure node:crypto, so
// we use a static fixture committed below. They're not real keys, just
// valid-looking PEM blobs that Node's `tls` parser will load — undici
// only needs them to *exist* and parse before it tries to talk to the
// (unreachable) target host.
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIBhTCCASugAwIBAgIUWOdTl0KXY1fPq1Y6f6CEv3YjJxgwCgYIKoZIzj0EAwIw
GTEXMBUGA1UEAwwOcGFya3NhcGktdGVzdHMwHhcNMjUwMTAxMDAwMDAwWhcNMzUw
MTAxMDAwMDAwWjAZMRcwFQYDVQQDDA5wYXJrc2FwaS10ZXN0czBZMBMGByqGSM49
AgEGCCqGSM49AwEHA0IABBuvixFwhk2hLN4Vqdsx0X+SYvEqHxlfKMhbsaeMd7+I
4yTUnAhMaMFL/pvJiwOsDp8RfbtyJyTQ2Iudw3sBEnujUzBRMB0GA1UdDgQWBBSo
0a4FH5W8eC4Vsd8c4OuNaS9w0DAfBgNVHSMEGDAWgBSo0a4FH5W8eC4Vsd8c4OuN
aS9w0DAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0gAMEUCIQCqLPsgwGfA
0WK1B4UBVnKcS3kDwh8gW1+oeYWk31IJiwIgWCkj/dRZIBeYuyYTlR+B+JD1BoBT
oRUGCMQRFvdnpMo=
-----END CERTIFICATE-----
`;
const TEST_KEY = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIIBQXl7vSnHgxRovGXJ6sJV+ddbEZHVGqNdaZ47PsgIWoAoGCCqGSM49
AwEHoUQDQgAEG6+LEXCGTaEs3hWp2zHRf5Ji8SofGV8oyFuxp4x3v4jjJNScCExo
wUv+m8mLA6wOnxF9u3InJNDYi53DewESew==
-----END EC PRIVATE KEY-----
`;

describe('makeHttpRequest mTLS plumbing', () => {
  test('attaches cert/key dispatcher without "invalid onRequestStart method"', async () => {
    // 192.0.2.1 is RFC 5737 TEST-NET-1 — guaranteed unroutable. The
    // request will fail with a connect error (timeout/ECONNREFUSED),
    // which is fine. The bug we're catching fires *before* the connect
    // attempt: undici walks the dispatcher interceptor chain at request
    // start, and a version-mismatched Agent throws "invalid
    // onRequestStart method" synchronously from inside the handler.
    let caught: any = null;
    try {
      await makeHttpRequest({
        method: 'GET',
        url: 'https://192.0.2.1/',
        cert: TEST_CERT,
        key: TEST_KEY,
        timeoutMs: 1500,
      });
    } catch (err) {
      caught = err;
    }

    // We expect *some* error (connect timeout) — but specifically NOT
    // an interceptor-contract mismatch. Walk both .message and any
    // chained `cause` for the regression marker.
    const messages: string[] = [];
    let e: any = caught;
    while (e) {
      if (e.message) messages.push(String(e.message));
      if (e.cause && e.cause !== e) e = e.cause;
      else break;
    }
    const joined = messages.join(' | ').toLowerCase();
    expect(joined, `Saw the dispatcher version-mismatch regression: ${messages.join(' / ')}`)
      .not.toMatch(/invalid onrequeststart method/);
  });
});
