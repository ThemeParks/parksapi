/**
 * Access control for the migration review server.
 *
 * The server commits entity id changes with the operator's wiki credential and
 * listens on every interface, so it can be reviewed from another machine.
 * Two checks keep everyone else out:
 *
 *  - A Host and Origin check, so another website cannot drive it through the
 *    operator's browser (cross-site posts, DNS rebinding).
 *  - A random token made for each run. The printed URL carries it once; the
 *    server answers by setting a SameSite=Strict HttpOnly cookie and
 *    redirecting to a clean URL, and every later request must carry the
 *    cookie. A machine on the network that was never given the URL gets a 401.
 *
 * Reviewing from a machine whose name is not recognised needs
 * MIGRATE_ALLOWED_HOSTS (comma separated hostnames, no ports).
 */
import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import type {RequestHandler} from 'express';
import {LOOPBACK_HOSTNAMES, refuseForeignHostOrOrigin} from '../../webServerSecurity.js';

const COOKIE_NAME = 'migrate_token';

export interface Access {
  token: string;
  allowed: Set<string>;
}

export function newAccessToken(): string {
  return randomBytes(24).toString('hex');
}

/** Loopback, this machine, MIGRATE_HOST (the name the tool prints) and MIGRATE_ALLOWED_HOSTS. */
export function migrateHostnames(env: NodeJS.ProcessEnv, machineName: string): Set<string> {
  const names = [
    ...LOOPBACK_HOSTNAMES,
    machineName,
    (env.MIGRATE_HOST ?? '').replace(/^\[|\]$/g, ''),
    ...(env.MIGRATE_ALLOWED_HOSTS ?? '').split(','),
  ];
  return new Set(names.map((name) => name.trim().toLowerCase()).filter(Boolean));
}

/** The address to open: the token rides along once and is swapped for a cookie. */
export function accessUrl(host: string, port: number, token: string): string {
  const bare = /^\[.+\]$/.test(host);
  const authority = !bare && host.includes(':') ? `[${host}]` : host;
  return `http://${authority}:${port}/?token=${token}`;
}

function sameToken(presented: string | undefined, token: string): boolean {
  if (!presented) return false;
  // Hash both so the comparison is constant time whatever the lengths.
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(token).digest();
  return timingSafeEqual(a, b);
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

export function migrateAccessGuard(access: Access): RequestHandler {
  const refuseForeign = refuseForeignHostOrOrigin(
    access.allowed,
    'Forbidden: this host name is not allowed. Set MIGRATE_ALLOWED_HOSTS to add it.',
  );

  return (req, res, next) =>
    refuseForeign(req, res, () => {
      const inUrl = typeof req.query.token === 'string' ? req.query.token : undefined;
      if (req.method === 'GET' && req.path === '/' && sameToken(inUrl, access.token)) {
        res.cookie(COOKIE_NAME, access.token, {httpOnly: true, sameSite: 'strict', path: '/'});
        res.set('Cache-Control', 'no-store');
        res.redirect(302, '/');
        return;
      }

      if (!sameToken(cookieValue(req.headers.cookie, COOKIE_NAME), access.token)) {
        res
          .status(401)
          .type('text/plain')
          .send('Unauthorised. Open the address printed when the tool started; it ends in ?token=...\n');
        return;
      }

      next();
    });
}
