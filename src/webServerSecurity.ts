/**
 * Network guard for the web admin server (webServer.ts).
 *
 * The admin API runs destination code and returns request traces, so it is for
 * the machine it runs on. Three rules keep it there:
 *
 *  - It binds the loopback interface unless WEB_ADMIN_HOST says otherwise.
 *  - A request is served only when its Host header names this machine. A page
 *    on another site can point its own hostname at 127.0.0.1 (DNS rebinding)
 *    and the Host header is the one thing it cannot rewrite.
 *  - A request that carries an Origin is served only when that origin is also
 *    this machine. A cross-site form or text/plain POST needs no preflight, so
 *    omitting CORS headers is not enough: the request has to be refused before
 *    the handler runs.
 *
 * WEB_ADMIN_ALLOWED_HOSTS (comma separated hostnames, no ports) adds names for
 * running the dev UI from another machine. Ports are not checked.
 */
import cors from 'cors';
import type {RequestHandler, Response} from 'express';

export const LOOPBACK_HOSTNAMES = ['localhost', '127.0.0.1', '::1'];

/** Where to listen. Loopback by default; WEB_ADMIN_HOST opts in to another interface. */
export function resolveBindHost(env: NodeJS.ProcessEnv): string {
  return env.WEB_ADMIN_HOST?.trim() || '127.0.0.1';
}

/**
 * The hostname in a Host header (`localhost:8888`, `[::1]:8888`) or an Origin
 * (`http://localhost:3000`), lowercased. Undefined for anything that does not
 * name a host, including the opaque origin `null`.
 */
export function hostnameOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const authority = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0].toLowerCase();

  const bracketed = /^\[([0-9a-f:.]+)\](?::\d*)?$/.exec(authority);
  if (bracketed) return bracketed[1];

  const plain = /^([a-z0-9._-]+)(?::\d*)?$/.exec(authority);
  if (!plain || plain[1] === 'null') return undefined;
  return plain[1];
}

/** Hostnames this server answers to: loopback plus WEB_ADMIN_ALLOWED_HOSTS. */
export function allowedHostnames(env: NodeJS.ProcessEnv): Set<string> {
  const extra = (env.WEB_ADMIN_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  return new Set([...LOOPBACK_HOSTNAMES, ...extra]);
}

/**
 * Refuses (403) a request whose Host header, or Origin header when it has one,
 * does not name an allowed host. Shared with the migration review server.
 */
export function refuseForeignHostOrOrigin(allowed: Set<string>, message = 'Forbidden'): RequestHandler {
  return (req, res, next) => {
    const host = hostnameOf(req.headers.host);
    if (!host || !allowed.has(host)) return refuse(res, message);

    if (req.headers.origin !== undefined) {
      const origin = hostnameOf(req.headers.origin);
      if (!origin || !allowed.has(origin)) return refuse(res, message);
    }

    next();
  };
}

function refuse(res: Response, message: string): void {
  res.status(403).json({error: message});
}

/** Refuses foreign Host and Origin headers, then answers CORS for the rest. */
export function webAdminGuard(env: NodeJS.ProcessEnv): RequestHandler {
  const refuseForeign = refuseForeignHostOrOrigin(allowedHostnames(env));
  // Only allowed origins get past the check above, so reflecting is safe.
  const answerCors = cors({origin: true});

  return (req, res, next) => refuseForeign(req, res, () => answerCors(req, res, next));
}
