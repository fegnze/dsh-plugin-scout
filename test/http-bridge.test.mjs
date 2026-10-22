import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { registerScoutRoutes, PREFIX } from '../src/host.mjs';

// Optional exact installed-Host integration; normal CI retains route-mode assertions.
const modulePath = process.env.SCOUT_CONNECTION_MODULE;
test('installed official HTTP bridge handles GET without body and bounded POST', { skip: !modulePath }, async () => {
  const { HostConnectionService } = await import(modulePath);
  const source = await readFile(modulePath, 'utf8');
  const start = source.indexOf('async function bridge(');
  assert.ok(start >= 0);
  const end = source.indexOf('//#endregion', start);
  const bridge = vm.runInNewContext(`(${source.slice(start, end).trim()})`, { Readable, Request, URL, AbortController, Buffer, DEFAULT_MAX_REQUEST_BODY_BYTES: 300 * 1024 * 1024 });
  const service = Object.create(HostConnectionService.prototype);
  service.fetchRoutes = new Map(); service.interceptors = new Map();
  const dispose = registerScoutRoutes({ fetch: { register: (route) => service.registerFetchRoute({ effect: (fn) => fn() }, route) } }, { status: () => ({ runtime: '0.2.1', loaded: true }), list: () => ({ rows: [] }) }, { run: async () => ({ configured: false }) });
  try {
    for (const [endpoint, method, body, expected] of [['status', 'GET', null, 200], ['auth', 'GET', null, 200], ['auth', 'POST', '{"action":"check"}', 200], ['list', 'POST', '{}', 200], ['auth', 'POST', 'x'.repeat(9000), 413]]) {
      const req = Readable.from(body ? [Buffer.from(body)] : []);
      req.url = `${PREFIX}/api/${endpoint}`; req.method = method; req.headers = { 'x-dsh-plugin-scout': '1' };
      const res = new EventEmitter(); res.writableEnded = false; const chunks = [];
      res.writeHead = (status) => { res.status = status; }; res.write = (chunk) => { chunks.push(Buffer.from(chunk)); return true; }; res.end = () => { res.writableEnded = true; };
      await bridge(req, res, service.createSharedFetchHandler('/api'), { principal: { kind: 'owner' } });
      assert.equal(res.status, expected, `${method} ${endpoint}`);
      assert.equal(JSON.parse(Buffer.concat(chunks)).ok, expected === 200);
    }
  } finally { dispose(); }
});
