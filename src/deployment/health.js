import { get } from 'node:https';
import { isLocalIdentity } from '../core/public-access.js';

export async function healthReady(endpoint, fetchImpl = fetch) {
  const url = new URL(`${endpoint}/health`);
  // Caddy uses its internal CA for private names. This unauthenticated health
  // probe checks that the edge serves requests; it does not change client trust.
  if (url.protocol === 'https:' && isLocalIdentity(url.hostname.replace(/^\[|\]$/g, ''))) {
    return new Promise(resolve => {
      const request = get(url, { rejectUnauthorized: false, signal: AbortSignal.timeout(3000) }, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; if (body.length > 65536) request.destroy(); });
        response.on('error', () => resolve(false));
        response.on('end', () => {
          try { resolve(response.statusCode === 200 && JSON.parse(body).restore?.status === 'ready'); }
          catch { resolve(false); }
        });
      });
      request.on('error', () => resolve(false));
    });
  }
  try {
    const response = await fetchImpl(url.href, { signal: AbortSignal.timeout(3000) });
    return response.ok && (await response.json()).restore?.status === 'ready';
  } catch { return false; }
}
