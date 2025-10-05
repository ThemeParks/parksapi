// HTTP client using node:http/https with optional proxy support (Node.js 24+)
import * as http from 'node:http';
import * as https from 'node:https';
import {URL} from 'node:url';

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
}): Promise<Response> {
  const {method, url, headers, body, proxyUrl} = options;

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

    // Create agent with proxy support if proxy URL is provided (Node.js 24+ feature)
    if (proxyUrl) {
      requestOptions.agent = new httpModule.Agent({
        proxy: proxyUrl,
      } as any); // Type assertion needed as proxy option is new in Node 24
    }

    const req = httpModule.request(requestOptions, (res) => {
      const chunks: Buffer[] = [];

      res.on('data', (chunk) => {
        chunks.push(chunk);
      });

      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const responseBody = buffer.toString('utf-8');

        // Create a Response object compatible with fetch API
        const responseHeaders: Record<string, string> = {};
        Object.entries(res.headers || {}).forEach(([key, value]) => {
          if (value) {
            responseHeaders[key] = Array.isArray(value) ? value.join(', ') : value;
          }
        });

        const response = new Response(responseBody, {
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
