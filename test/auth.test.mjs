import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createAuth, TOKEN_REF } from '../src/auth.mjs';
import { createHandler, registerScoutRoutes, PREFIX } from '../src/host.mjs';
test('shared carrier adapter preserves intent fence and streaming credential limits', async () => {
  const routes = new Map(); const { auth } = setup();
  const dispose = registerScoutRoutes({ fetch: { register(route) { assert.ok(route.path.startsWith('/api/')); routes.set(route.path, route); return () => routes.delete(route.path); } } }, { status: () => ({ loaded: true }) }, auth);
  const route = routes.get(`${PREFIX}/api/auth`);
  assert.equal(route.requestBody, 'streaming');
  const call = (body, intent = true) => route.fetch(new Request(`http://desktop${route.path}`, { method: 'POST', headers: intent ? { 'x-dsh-plugin-scout': '1' } : {}, body }));
  assert.equal((await call(JSON.stringify({ action: 'save', token: secret }), false)).status, 403);
  assert.equal((await call('x'.repeat(9000))).status, 413);
  const saved = await call(JSON.stringify({ action: 'save', token: secret })); assert.equal(saved.status, 200); assert.equal((await saved.json()).value.stored, true);
  const status = await routes.get(`${PREFIX}/api/status`).fetch(new Request(`http://desktop${PREFIX}/api/status`, { headers: { 'x-dsh-plugin-scout': '1' } }));
  assert.equal((await status.json()).value.loaded, true);
  dispose(); assert.equal(routes.size, 0);
});
const secret = 'ghp_PRIVATE_TEST_TOKEN_123456789';
function setup(fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: { rateLimit: { remaining: 100 } } }) })) {
  let value; const writes = [];
  const credentials = { resolve: async () => value ? { value, source: 'file' } : undefined, describe: async () => ({ configured: !!value, writable: true, ...(value ? { source: 'file' } : {}) }), set: async (ref, v) => { writes.push(ref); value = v; }, unset: async (ref) => { writes.push(ref); value = undefined; } };
  const auth = createAuth({ credentials, fallback: async () => ({ source: 'none' }), fetch });
  return { auth, writes };
}
test('credentials save/resolve/check/clear uses only the fixed reference and redacts every view', async () => {
  const { auth, writes } = setup(async (url, init) => {
    assert.equal(url, 'https://api.github.com/graphql'); assert.equal(init.redirect, 'error'); assert.equal(init.headers.authorization, `Bearer ${secret}`);
    assert.ok(!init.body.includes('mutation'));
    return { ok: true, status: 200, json: async () => ({ data: { rateLimit: { remaining: 2 } } }) };
  });
  assert.equal((await auth.run()).configured, false);
  const saved = await auth.run('save', secret); assert.equal(saved.stored, true); assert.equal(JSON.stringify(saved).includes(secret), false);
  assert.equal((await auth.resolve()).token, secret);
  const checked = await auth.run('check'); assert.equal(checked.check.ok, true); assert.equal(JSON.stringify(checked).includes(secret), false);
  assert.equal((await auth.run('clear')).configured, false); assert.deepEqual(writes, [TOKEN_REF, TOKEN_REF]);
  await assert.rejects(auth.run('save', 'bad'), { status: 400 });
});
test('clear reveals ambient fallback and unsupported hosts refuse persistent writes', async () => {
  const auth = createAuth({ fallback: async () => ({ token: secret, source: 'gh auth token' }) });
  assert.equal((await auth.run()).source, 'gh auth token'); assert.equal((await auth.run()).writable, false);
  await assert.rejects(auth.run('save', secret), { status: 503 });
  const missing = createAuth({ fallback: async () => ({}) }); assert.equal((await missing.run('check')).check.code, 'no-token');
  let stored = secret;
  const layered = createAuth({ credentials: { resolve: async () => stored ? { value: stored, source: 'file' } : undefined, describe: async () => ({ configured: !!stored, source: stored ? 'file' : undefined, writable: true }), set: async () => {}, unset: async () => { stored = undefined; } }, fallback: async () => ({ token: secret, source: 'GITHUB_TOKEN' }) });
  const cleared = await layered.run('clear'); assert.equal(cleared.stored, false); assert.equal(cleared.configured, true); assert.equal(cleared.source, 'GITHUB_TOKEN');
});
test('connection checks have fixed errors and never project upstream text', async () => {
  for (const [status, headers, code] of [[401, {}, 'invalid-token'], [403, {}, 'permission'], [429, {}, 'rate-limit'], [403, { 'x-ratelimit-remaining': '0' }, 'rate-limit'], [502, {}, 'github-error']]) {
    const { auth } = setup(async () => ({ status, ok: false, headers: new Headers(headers), json: async () => { throw Error(secret); } }));
    await auth.run('save', secret); const view = await auth.run('check'); assert.equal(view.check.code, code); assert.equal(JSON.stringify(view).includes(secret), false);
  }
  const { auth } = setup(async () => { throw Error(secret); }); await auth.run('save', secret); assert.equal((await auth.run('check')).check.code, 'network');
});
async function request(handler, method, body, headers = { 'x-dsh-plugin-scout': '1' }) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]); req.method = method; req.url = `${PREFIX}/api/auth`; req.headers = headers;
  let status, value; await handler(req, { writeHead: (s) => { status = s; }, end: (b) => { value = JSON.parse(b); } }); return { status, value };
}
test('auth routes are owner-only, intent-fenced, bounded and secret-free on provider/parser failure', async () => {
  let calls = 0;
  const auth = { run: async () => { calls++; throw Error(secret); } };
  const handler = (principal) => createHandler({}, { auth, admit: () => ({ peer: { principal } }) });
  assert.equal((await request(handler({ kind: 'agent' }), 'POST', '{}')).status, 403);
  assert.equal((await request(handler({ kind: 'owner' }), 'GET', undefined, {})).status, 403); assert.equal(calls, 0);
  const owner = handler({ kind: 'owner' });
  assert.equal((await request(owner, 'POST', `{"token":"${secret}"`)).status, 400);
  assert.equal((await request(owner, 'POST', 'x'.repeat(9000))).status, 413);
  assert.equal((await request(owner, 'POST', 'null')).status, 400);
  const failed = await request(owner, 'POST', JSON.stringify({ action: 'save', token: secret })); assert.equal(failed.status, 503); assert.equal(JSON.stringify(failed).includes(secret), false);
});
