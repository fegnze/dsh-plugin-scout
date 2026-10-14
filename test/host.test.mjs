import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Config, PREFIX, apply, createHandler, createScout } from '../src/host.mjs';

const RT = { runtime: '0.2.0-rc.2', source: 'test' };
const T0 = Date.parse('2026-10-14T00:00:00Z');

const pkg = (name, extra = {}) => JSON.stringify({ name, version: '1.0.0', description: 'session memory', peerDependencies: { '@deepseek-ai/dsh': '^0.2.0-rc.1' }, dsh: { bundle: {} }, repository: `github:o/${name}`, ...extra });
const node = (owner, name, pkgText, extra = {}) => ({
  id: `id:${owner}/${name}`, nameWithOwner: `${owner}/${name}`, description: 'd', stargazerCount: 3, pushedAt: '2026-10-01T00:00:00Z', createdAt: '2026-09-01T00:00:00Z',
  isArchived: false, isFork: false, licenseInfo: { spdxId: 'MIT' }, repositoryTopics: { nodes: [{ topic: { name: 'dsh-plugin' } }] },
  pkg: pkgText == null ? null : { text: pkgText }, patch: null, ...extra,
});

/** Fake GitHub + npm on one fetch: COUNT → n, QUERY → nodes, npm → manifest or 404. */
function fakeFetch(nodes, npm = {}) {
  const calls = { gql: 0, npm: [] };
  const fetch = async (url, init) => {
    const reply = (status, body) => ({ status, ok: status < 300, headers: new Headers(), json: async () => body });
    if (String(url).includes('registry.npmjs.org')) {
      const name = decodeURIComponent(String(url).split('registry.npmjs.org/')[1].replace(/\/latest$/, ''));
      calls.npm.push(name);
      return npm[name] ? reply(200, npm[name]) : reply(404, {});
    }
    calls.gql++;
    const { query } = JSON.parse(init.body);
    if (/repositoryCount/.test(query) && !/nodes/.test(query)) return reply(200, { data: { search: { repositoryCount: nodes.length } } });
    return reply(200, { data: { search: { repositoryCount: nodes.length, nodes, pageInfo: { hasNextPage: false, endCursor: null } } } });
  };
  return { fetch, calls };
}

async function tmp() { return mkdtemp(join(tmpdir(), 'scout-')); }

async function settle(scout) { for (let i = 0; i < 200 && scout.status().running; i++) await new Promise((r) => setTimeout(r, 5)); }

test('Config validator accepts the documented keys and rejects junk', () => {
  const v = Config['~standard'].validate;
  assert.deepEqual(v(undefined).value, {});
  assert.deepEqual(v({ topic: 'dsh-plugin', autoRefreshHours: 0 }).value, { topic: 'dsh-plugin', autoRefreshHours: 0 });
  assert.ok(v({ topic: '' }).issues);
  assert.ok(v({ autoRefreshHours: -1 }).issues);
  assert.ok(v([]).issues);
});

test('refresh: full crawl writes a facts-only index, npm looked up for plugins only, verdicts derived on load', async () => {
  const dir = await tmp();
  try {
    const file = join(dir, 'index.json');
    const nodes = [node('o', 'alpha', pkg('alpha')), node('o', 'notes', JSON.stringify({ name: 'notes' })), node('o', 'empty', null)];
    const { fetch, calls } = fakeFetch(nodes, { alpha: { name: 'alpha', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh': '^0.2.0-rc.1' }, dsh: { bundle: {} }, repository: 'github:o/alpha' } });
    const scout = createScout({ file, runtime: RT, fetch, now: () => T0, getToken: async () => ({ token: 't'.repeat(30), source: 'test' }) });
    await scout.load();
    assert.equal(scout.status().crawledAt ?? null, null);
    assert.equal(scout.refresh('full'), true);
    assert.equal(scout.refresh('full'), false, 'single flight');
    await settle(scout);
    assert.equal(scout.status().error, null);
    assert.deepEqual(calls.npm, ['alpha']);
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(saved.fullAt, new Date(T0).toISOString());
    assert.equal(Object.keys(saved.repos).length, 3);
    assert.equal(saved.repos['o/notes'].plugin, false);
    assert.equal(saved.repos['o/alpha'].score, undefined, 'index stores facts, not verdicts');
    assert.equal(scout.records.length, 1);
    assert.equal(scout.records[0].chain, 'match');
    // 重新加载：同一份事实在新运行时下现算出不同结论。
    const later = createScout({ file, runtime: { runtime: '0.3.0', source: 'test' }, fetch, getToken: async () => ({}) });
    await later.load();
    assert.equal(later.records[0].compat, 'incompatible');
    // 第二次默认是增量，按 pushed 抓。
    const seen = [];
    const spy = async (u, init) => { if (init?.body) seen.push(JSON.parse(init.body).variables.q); return fetch(u, init); };
    const inc = createScout({ file, runtime: RT, fetch: spy, now: () => T0 + 3_600_000, getToken: async () => ({ token: 't'.repeat(30) }) });
    await inc.load();
    inc.refresh();
    await settle(inc);
    assert.equal(inc.status().kind, 'incremental');
    assert.ok(seen.every((q) => /pushed:/.test(q)), seen[0]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('refresh without a token fails visibly and leaves the index untouched', async () => {
  const dir = await tmp();
  try {
    const scout = createScout({ file: join(dir, 'i.json'), runtime: RT, fetch: async () => { throw new Error('no network expected'); }, getToken: async () => ({ token: undefined }) });
    await scout.load();
    scout.refresh();
    await settle(scout);
    assert.equal(scout.status().error.code, 'no-token');
    assert.equal(scout.status().running, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

function call(handler, { method = 'GET', url, headers = { 'x-dsh-plugin-scout': '1' }, body, raw } = {}) {
  const text = raw ?? (body ? JSON.stringify(body) : '');
  const req = Readable.from(text ? [Buffer.from(text)] : []);
  Object.assign(req, { method, url, headers });
  return new Promise((resolve) => {
    const res = { status: 0, headers: {}, writeHead(s, h) { this.status = s; this.headers = h; }, end(t) { resolve({ status: this.status, headers: this.headers, body: JSON.parse(t) }); } };
    handler(req, res);
  });
}

function seeded(gate = Promise.resolve()) {
  const scout = createScout({ file: '/nonexistent', runtime: RT, fetch: async () => { throw new Error('x'); }, getToken: async () => { await gate; return {}; } });
  scout._set({ version: 1, crawledAt: '2026-10-13T00:00:00Z', fullAt: '2026-10-13T00:00:00Z', npm: {}, repos: {
    'o/alpha': { repo: 'o/alpha', description: 'memory', stars: 9, pushedAt: '2026-10-01T00:00:00Z', createdAt: '2026-09-01T00:00:00Z', archived: false, fork: false, license: 'MIT', topics: ['dsh-plugin'], pkg: JSON.parse(pkg('alpha')), inserts: [] },
  } });
  return scout;
}

test('handler: intent header and DSH admission are both required', async () => {
  const scout = seeded();
  const ok = createHandler(scout, { admit: () => ({ peer: {} }) });
  assert.equal((await call(ok, { url: `${PREFIX}/api/status`, headers: {} })).status, 403);
  assert.equal((await call(createHandler(scout, { admit: () => ({ rejection: 401 }) }), { url: `${PREFIX}/api/status` })).status, 401);
  assert.equal((await call(createHandler(scout, { admit: () => undefined }), { url: `${PREFIX}/api/status` })).status, 403, 'no connection service → fail closed');
  const s = await call(ok, { url: `${PREFIX}/api/status` });
  assert.equal(s.status, 200);
  assert.equal(s.headers['cache-control'], 'no-store');
  assert.equal(s.body.value.runtime, '0.2.0-rc.2');
});

test('handler: list / detail / badges / refresh / 404', async () => {
  let open;
  const scout = seeded(new Promise((r) => { open = r; }));
  const h = createHandler(scout, { admit: () => ({ peer: {} }) });
  const l = await call(h, { method: 'POST', url: `${PREFIX}/api/list`, body: { q: 'alpha', sort: 'score' } });
  assert.equal(l.body.value.total, 1);
  assert.equal(l.body.value.rows[0].spec, 'github:o/alpha');
  const d = await call(h, { url: `${PREFIX}/api/detail?key=O/Alpha` });
  assert.equal(d.body.value.name, 'alpha');
  assert.ok(Array.isArray(d.body.value.checks));
  assert.equal((await call(h, { url: `${PREFIX}/api/detail?key=nope` })).status, 404);
  const b = await call(h, { method: 'POST', url: `${PREFIX}/api/badges`, body: { names: ['alpha', 'ghost'] } });
  assert.deepEqual(Object.keys(b.body.value), ['alpha']);
  assert.equal(typeof b.body.value.alpha.score, 'number');
  const r1 = await call(h, { method: 'POST', url: `${PREFIX}/api/refresh`, body: { full: true } });
  assert.equal(r1.status, 202);
  const r2 = await call(h, { method: 'POST', url: `${PREFIX}/api/refresh`, body: {} });
  assert.equal(r2.status, 409);
  open();
  await settle(scout);
  assert.equal(scout.status().error.code, 'no-token');
  const bad = await call(h, { method: 'POST', url: `${PREFIX}/api/badges`, raw: '{' });
  assert.equal(bad.status, 500);
  assert.equal(bad.body.ok, false);
  assert.equal((await call(h, { url: `${PREFIX}/api/zzz` })).status, 404);
});

test('apply: registers one prefix route through ctx.effect and tears it down', async () => {
  const dir = await tmp();
  try {
    const routes = [];
    let teardown;
    const ctx = {
      webServer: { register(r) { routes.push(r); return () => routes.splice(routes.indexOf(r), 1); } },
      subprocess: { spawn() { throw new Error('not in test'); } },
      effect(fn) { teardown = fn(); },
      get: () => ({ admit: () => ({ peer: {} }) }),
      logger: { info() {}, warn() {} },
    };
    await apply(ctx, { dataDir: dir, runtimeVersion: '0.2.0-rc.2', autoRefreshHours: 0 });
    assert.equal(routes.length, 1);
    assert.equal(routes[0].kind, 'prefix');
    assert.equal(routes[0].path, PREFIX);
    const s = await call(routes[0].handler, { url: `${PREFIX}/api/status` });
    assert.equal(s.body.value.runtimeSource, 'config');
    await teardown();
    assert.equal(routes.length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

/** 可控的 GitHub：按查询里的时间窗决定计数与节点；`hold(q)` 返回的 promise 未决前该窗的翻页挂起。 */
function windowFetch({ total, windowsOf, hold = () => undefined, npm = {} }) {
  const calls = { npm: [], byIds: [] };
  const byId = new Map();
  const reply = (status, body) => ({ status, ok: status < 300, headers: new Headers(), json: async () => body });
  const fetch = async (url, init) => {
    if (String(url).includes('registry.npmjs.org')) {
      const name = decodeURIComponent(String(url).split('registry.npmjs.org/')[1].replace(/\/latest$/, ''));
      calls.npm.push(name);
      return npm[name] ? reply(200, npm[name]) : reply(404, {});
    }
    const { query, variables } = JSON.parse(init.body);
    if (variables.ids) { calls.byIds.push(variables.ids); return reply(200, { data: { nodes: variables.ids.map((id) => byId.get(id)) } }); }
    const nodes = windowsOf(variables.q);
    for (const n of nodes) byId.set(n.id, n);
    if (!/nodes\{/.test(query)) return reply(200, { data: { search: { repositoryCount: nodes.length || total } } });
    await hold(variables.q);
    return reply(200, { data: { search: { repositoryCount: nodes.length, nodes, pageInfo: { hasNextPage: false, endCursor: null } } } });
  };
  return { fetch, calls };
}

test('refresh streams: results are published while GitHub is still paging, old index stays served', async () => {
  const dir = await tmp();
  try {
    const file = join(dir, 'index.json');
    let release;
    const gate = new Promise((r) => { release = r; });
    // 首窗（新）立即返回；另一窗（旧）卡住。总数 1000 迫使二分出两个窗。
    const { fetch } = windowFetch({
      total: 1000,
      // 总数窗（2008..现在）只给计数；最老的播种窗出 old（翻页卡住）；最新的播种窗出 fresh；中间窗为空。
      windowsOf: (q) => (/created:2008/.test(q) ? (/\.\.2026-10-14/.test(q) ? [] : [node('o', 'old', pkg('old'))]) : /\.\.2026-10-14T00:00:00Z$/.test(q) ? [node('o', 'fresh', pkg('fresh'))] : []),
      hold: (q) => (/created:2008/.test(q) ? gate : undefined),
    });
    const scout = createScout({ file, runtime: RT, fetch, now: () => T0, publishMs: 0, getToken: async () => ({ token: 't'.repeat(30) }) });
    scout._set({ version: 1, npm: {}, repos: { 'o/stale': factOfLike('stale') } });
    const rev0 = scout.status().rev;
    scout.refresh('full');
    const t = setTimeout(() => release(), 3000);
    for (let i = 0; i < 200 && !scout.records.some((r) => r.name === 'fresh'); i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(scout.status().running, 'still crawling');
    assert.ok(scout.status().rev > rev0, 'published mid-flight');
    assert.deepEqual(scout.records.map((r) => r.name).sort(), ['fresh', 'stale'], 'old index still served during a refresh');
    assert.ok(scout.status().progress.published >= 1 || scout.status().progress.phase === 'github');
    release();
    clearTimeout(t);
    await settle(scout);
    assert.equal(scout.status().error, null);
    assert.deepEqual(scout.records.map((r) => r.name).sort(), ['fresh', 'old'], 'full refresh prunes repos it no longer sees');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

function factOfLike(name) {
  return { repo: `o/${name}`, description: 'memory', stars: 1, pushedAt: '2026-10-01T00:00:00Z', createdAt: '2026-09-01T00:00:00Z', archived: false, fork: false, license: 'MIT', topics: ['dsh-plugin'], pkg: JSON.parse(pkg(name)) };
}

test('incremental refresh keeps unseen repos and caps stale npm re-checks oldest first', async () => {
  const dir = await tmp();
  try {
    const file = join(dir, 'index.json');
    const { fetch, calls } = windowFetch({ total: 0, windowsOf: () => [] });
    const old = (d) => ({ at: T0 - d * 86_400_000, m: null });
    const scout = createScout({ file, runtime: RT, fetch, now: () => T0, staleBatch: 2, getToken: async () => ({ token: 't'.repeat(30) }) });
    scout._set({ version: 1, crawledAt: '2026-10-13T00:00:00Z', fullAt: '2026-10-01T00:00:00Z',
      npm: { a: old(30), b: old(9), c: old(20), d: old(1) },
      repos: { 'o/a': factOfLike('a'), 'o/b': factOfLike('b'), 'o/c': factOfLike('c'), 'o/d': factOfLike('d'), 'o/e': factOfLike('e') } });
    scout.refresh();
    await settle(scout);
    assert.equal(scout.status().kind, 'incremental');
    assert.equal(scout.status().error, null);
    // 过期（>7 天）的 a/c/b 只补最旧的 2 个；从没查过的 e 另算一份配额；d 未过期不查。
    assert.deepEqual(calls.npm.sort(), ['a', 'c', 'e']);
    assert.equal(scout.records.length, 5, 'incremental never prunes');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('apply does not wait for the index: status answers loaded:false first, then loaded:true', async () => {
  const dir = await tmp();
  try {
    const routes = [];
    const ctx = {
      webServer: { register(r) { routes.push(r); return () => {}; } },
      subprocess: { spawn() { throw new Error('not in test'); } },
      effect(fn) { fn(); },
      get: () => ({ admit: () => ({ peer: {} }) }),
      logger: { info() {}, warn() {} },
    };
    await apply(ctx, { dataDir: dir, runtimeVersion: '0.2.0-rc.2', autoRefreshHours: 0 });
    const first = await call(routes[0].handler, { url: `${PREFIX}/api/status` });
    assert.equal(typeof first.body.value.loaded, 'boolean');
    for (let i = 0; i < 100; i++) { if ((await call(routes[0].handler, { url: `${PREFIX}/api/status` })).body.value.loaded) break; await new Promise((r) => setTimeout(r, 5)); }
    assert.equal((await call(routes[0].handler, { url: `${PREFIX}/api/status` })).body.value.loaded, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
