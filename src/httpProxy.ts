// HTTP client using node:http/https with optional proxy support (Node.js 24+)
import * as http from 'node:http';
import * as https from 'node:https';
import * as zlib from 'node:zlib';
import {URL} from 'node:url';
import {pipeline} from 'node:stream';

/**
 * Make an HTTP request using node:http/https with optional proxy support
 * Uses Node.js 24+ built-in proxy support via Agent when proxy is provided
 *
 * @param options Request options
 * @returns Response object compatible with fetch Response
 */
export async function makeHttpRequest(options: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: any;
  proxyUrl?: string;
  /** Client SSL certificate (PEM format) for mutual TLS */
  cert?: string;
  /** Client SSL private key (PEM format) for mutual TLS */
  key?: string;
}): Promise<Response> {
  const {method, url, headers, body, proxyUrl, cert, key} = options;

  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const isHttps = urlObj.protocol === 'https:';
    const httpModule = isHttps ? https : http;

    const requestOptions: http.RequestOptions = {
      method,
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      headers: headers || {},
    };

    // Client SSL certificate for mutual TLS (e.g., PortAventura)
    if (isHttps && (key || cert)) {
      (requestOptions as any).key = key;
      (requestOptions as any).cert = cert;
    }

    // Create agent with proxy support if proxy URL is provided (Node.js 24+ feature)
    if (proxyUrl) {
      requestOptions.agent = new httpModule.Agent({
        proxy: proxyUrl,
      } as any); // Type assertion needed as proxy option is new in Node 24
    }

    const hdrs = requestOptions.headers as Record<string, string>;

    // Default User-Agent — parks that need app-specific UAs override via @inject
    if (!hdrs['user-agent'] && !hdrs['User-Agent']) {
      hdrs['user-agent'] = process.env.DEFAULT_USER_AGENT || 'parksapi/2.0';
    }

    // Add Accept-Encoding header to request compressed responses
    if (!hdrs['accept-encoding'] && !hdrs['Accept-Encoding']) {
      hdrs['accept-encoding'] = 'gzip, deflate, br';
    }

    const req = httpModule.request(requestOptions, (res) => {
      const chunks: Buffer[] = [];

      // Select decompression stream based on content-encoding
      const encoding = res.headers['content-encoding'];
      let stream: NodeJS.ReadableStream = res;

      if (encoding === 'gzip' || encoding === 'x-gzip') {
        stream = res.pipe(zlib.createGunzip());
      } else if (encoding === 'deflate') {
        stream = res.pipe(zlib.createInflate());
      } else if (encoding === 'br') {
        stream = res.pipe(zlib.createBrotliDecompress());
      }

      stream.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });

      stream.on('error', (error: Error) => {
        reject(error);
      });

      stream.on('end', () => {
        const buffer = Buffer.concat(chunks);

        // Create a Response object compatible with fetch API
        const responseHeaders: Record<string, string> = {};
        Object.entries(res.headers || {}).forEach(([key, value]) => {
          if (value) {
            responseHeaders[key] = Array.isArray(value) ? value.join(', ') : value;
          }
        });

        // Pass raw buffer to preserve binary data (ZIP, images, etc.)
        // Response constructor accepts ArrayBuffer/Uint8Array natively.
        const response = new Response(buffer, {
          status: res.statusCode || 200,
          statusText: res.statusMessage || 'OK',
          headers: responseHeaders,
        });

        resolve(response);
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    // Send body if present
    if (body) {
      if (typeof body === 'string') {
        req.write(body);
      } else if (typeof body === 'object') {
        req.write(JSON.stringify(body));
      } else {
        req.write(body);
      }
    }

    req.end();
  });
}
