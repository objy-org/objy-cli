import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createManager } from '../manager.js';
import { doctor, targetId } from '../doctor.js';
import { normalizeAnswers, splitAnswers } from '../deployment/catalog.js';
import { credentialDefaults, withCredentials } from '../deployment/input.js';
import { redact } from '../deployment/files.js';

export async function startUi({ environment = process.env, manager = createManager({ environment }), doctorImpl = doctor,
  host = '127.0.0.1', port = 7340, openBrowser = true } = {}) {
  if (host !== '127.0.0.1') throw new Error('The UI must listen on 127.0.0.1');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Choose a port from 0 to 65535');
  const token = randomBytes(32).toString('hex');
  const nonce = randomBytes(24).toString('base64');
  const jobs = new Map(), running = new Map();
  const credentials = credentialDefaults(environment);
  const html = (await readFile(new URL('./index.html', import.meta.url), 'utf8')).replaceAll('__NONCE__', nonce).replace('__TOKEN__', token);
  const catalog = await readFile(new URL('../deployment/catalog.js', import.meta.url));
  const server = createServer(async (request, response) => {
    try {
      const expectedHost = `127.0.0.1:${server.address().port}`;
      if (request.headers.host !== expectedHost) return json(response, 403, { error: 'Invalid local host' });
      const origin = `http://${expectedHost}`;
      if (request.headers.origin && request.headers.origin !== origin) return json(response, 403, { error: 'Cross-origin requests are not allowed' });
      const url = new URL(request.url, origin);
      response.setHeader('cache-control', 'no-store');
      response.setHeader('x-content-type-options', 'nosniff');
      response.setHeader('referrer-policy', 'no-referrer');
      response.setHeader('content-security-policy', `default-src 'none'; script-src 'self' 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
      if (request.method === 'GET' && url.pathname === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return response.end(html);
      }
      if (request.method === 'GET' && url.pathname === '/catalog.js') {
        response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); return response.end(catalog);
      }
      if (request.headers['x-objy-token'] !== token) return json(response, 403, { error: 'This session has expired. Refresh the page to reconnect.' });
      if (request.headers['sec-fetch-site'] === 'cross-site') return json(response, 403, { error: 'Cross-origin requests are not allowed' });
      if (request.method === 'GET' && url.pathname === '/api/session') return json(response, 200, { providedCredentials: Object.keys(credentials) });
      if (request.method === 'GET' && url.pathname === '/api/clusters') return json(response, 200, await manager.list());
      if (request.method === 'GET' && url.pathname === '/api/jobs') return json(response, 200, [...jobs.values()]);
      if (request.method === 'POST' && url.pathname === '/api/deploy') {
        const body = await readBody(request);
        const values = normalizeAnswers(withCredentials({ ...body.answers, target: targetId(body.answers?.target) }, environment));
        const secrets = splitAnswers(values).secrets;
        return json(response, 202, launch(values.name, 'deploy', onEvent => manager.deploy(values, { onEvent }), secrets));
      }
      if (request.method === 'POST' && url.pathname === '/api/doctor') {
        const { target, protocol = 'http' } = await readBody(request);
        if (!['http', 'https'].includes(protocol)) throw new Error('Choose HTTP or HTTPS');
        return json(response, 200, await doctorImpl(target, { protocol, environment }));
      }
      const match = url.pathname.match(/^\/api\/clusters\/([a-z][a-z0-9-]{0,47})(?:\/(logs|actions|deletion|rename))?$/);
      if (match) {
        const [, name, resource] = match;
        if (request.method === 'GET' && !resource) return json(response, 200, await manager.status(name));
        if (request.method === 'GET' && resource === 'deletion') return json(response, 200, await manager.deletionInfo(name));
        if (request.method === 'POST' && resource === 'rename') {
          if (running.has(name)) throw Object.assign(new Error('An operation is already running for this cluster'), { statusCode: 409 });
          const { newName, id } = await readBody(request);
          const result = await manager.rename(name, newName, { expectedId: id });
          for (const job of jobs.values()) if (job.name === name) job.name = result.name;
          return json(response, 200, result);
        }
        if (request.method === 'GET' && resource === 'logs') return json(response, 200, { logs: await manager.logs(name, {
          node: url.searchParams.get('node') || undefined, tail: Number(url.searchParams.get('lines') || 100),
        }) });
        if (request.method === 'POST' && resource === 'actions') {
          const { action, confirmation, id } = await readBody(request);
          if (action === 'delete') {
            const preview = await manager.deletionInfo(name);
            if (id !== preview.id || confirmation !== preview.name) throw new Error('Type the current deployment name to confirm deletion');
            if (preview.blockedBy.length) throw Object.assign(new Error(`Storage is used by ${preview.blockedBy.join(', ')}. Delete those deployments first or move their storage.`), { statusCode: 409 });
            return json(response, 202, launch(name, 'delete', onEvent => manager.delete(id, { confirmation, onEvent })));
          }
          if (!['start', 'stop', 'restart', 'resume'].includes(action)) throw new Error('Unknown cluster action');
          return json(response, 202, launch(name, action, onEvent => action === 'resume' ? manager.resume(name, { onEvent }) : manager.act(name, action, { onEvent })));
        }
      }
      json(response, 404, { error: 'Not found' });
    } catch (error) {
      json(response, error.statusCode || 400, { error: redact(error.message, credentials) });
    }
  });
  function launch(name, action, operation, secrets = {}) {
    if (running.has(name)) throw Object.assign(new Error('An operation is already running for this cluster'), { statusCode: 409 });
    if (running.size >= 8) throw Object.assign(new Error('Wait for a running operation to finish'), { statusCode: 429 });
    for (const [id, job] of jobs) if (jobs.size >= 40 && job.status !== 'running') jobs.delete(id);
    const job = { id: randomUUID(), name, action, status: 'running', events: [], startedAt: new Date().toISOString() };
    jobs.set(job.id, job);
    const safe = message => redact(message, { ...credentials, ...secrets });
    const onEvent = event => { job.events.push({ message: safe(event.message), at: new Date().toISOString() }); job.events = job.events.slice(-100); };
    const promise = Promise.resolve().then(() => operation(onEvent)).then(result => {
      job.resultState = result?.state;
      job.status = 'complete'; onEvent({ message: result?.state === 'deleted' ? 'Deployment deleted' : action === 'deploy' ? 'Your cluster is ready' : 'Operation complete' });
    }).catch(error => { job.status = 'failed'; job.error = safe(error.message); onEvent({ message: job.error }); })
      .finally(() => { job.finishedAt = new Date().toISOString(); running.delete(name); });
    running.set(name, promise);
    return job;
  }
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const url = `http://${host}:${server.address().port}`;
  if (openBrowser) launchBrowser(url);
  return { server, url, manager, settled: () => Promise.all([...running.values()]), close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify(body));
}
async function readBody(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw Object.assign(new Error('Expected JSON'), { statusCode: 415 });
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 131072) throw Object.assign(new Error('Request is too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object');
  return value;
}
function launchBrowser(url) {
  const binary = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd.exe' : 'xdg-open';
  const child = spawn(binary, process.platform === 'win32' ? ['/c', 'start', '', url] : [url], { detached: true, stdio: 'ignore' });
  child.on('error', () => {}); child.unref();
}
