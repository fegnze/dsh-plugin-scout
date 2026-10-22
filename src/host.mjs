// DSH Plugin Scout — Host 半边。
// 职责：抓 GitHub topic:dsh-plugin + npm，存事实索引，按需核验；经 DSH webServer 提供查询和凭证设置接口。
// 边界：不安装、不卸载、不启用任何插件（那是官方插件页的事）；不起常驻进程，子进程只用于 `gh auth token`，走 subprocess 服务。
import { createAuth } from './auth.mjs';
import { homedir } from 'node:os';
import { Readable } from 'node:stream';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { canonicalGithubSlug, crawlRepos, createGithub, npmLatest, pool } from './core/crawl.mjs';
import { createRecordSet, emptyIndex, facets, factOf, loadIndex, query, saveIndex } from './core/store.mjs';
import { CATEGORIES } from './core/classify.mjs';
import { installSpec } from './core/verify.mjs';

export const name = 'dsh-plugin-scout';
export const inject = ['connection', 'subprocess'];

export const PREFIX = '/api/dsh-plugin-scout';
const DAY = 86_400_000;
const NPM_TTL = DAY;
const AUTO_DELAY = 45_000;
const HOUR = 3_600_000;

/** One lifecycle-owned timer; missed intervals are never replayed. */
export function startAutoRefresh(scout, { enabled = true, hours = 1, now = Date.now, schedule = setTimeout, cancel = clearTimeout } = {}) {
  let disposed = false;
  let timer;
  const interval = hours * HOUR;
  const tick = async () => {
    try {
      await scout.load().catch(() => {});
      if (disposed) return;
      const status = scout.status();
      const last = Date.parse(status.succeededAt ?? status.crawledAt);
      if (!status.running && (!Number.isFinite(last) || now() - last >= interval)) scout.refresh();
    } catch { /* load errors are reported by Host; retry on the next interval */ }
    finally { if (!disposed) timer = schedule(tick, interval); }
  };
  if (enabled && Number.isFinite(interval) && interval > 0) timer = schedule(tick, AUTO_DELAY);
  return () => { disposed = true; if (timer !== undefined) cancel(timer); };
}
/** 刷新期间每隔多久把新到的结果发布给界面。 */
const PUBLISH_MS = 1_500;
/** 刷新期间每隔多久把已抓到的事实落盘（断点）。 */
const CHECKPOINT_MS = 30_000;
const NPM_CONCURRENCY = 8;
/** 每轮最多补查多少个过期的 npm 清单。 */
const NPM_STALE_BATCH = 800;
/** 单轮固定快照，最多 100 个精确仓库查询、3 路并发；不递归扩展 npm 或仓库队列。 */
const CANONICAL_BATCH = 100;
const CANONICAL_CONCURRENCY = 3;

export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-plugin-scout',
    validate(value) {
      if (value == null) return { value: {} };
      if (typeof value !== 'object' || Array.isArray(value)) return { issues: [{ message: 'config must be an object' }] };
      const out = {};
      for (const k of ['dataDir', 'topic', 'runtimeVersion']) {
        if (value[k] === undefined) continue;
        if (typeof value[k] !== 'string' || !value[k].trim()) return { issues: [{ message: `${k} must be a non-empty string`, path: [k] }] };
        out[k] = value[k];
      }
      if (value.autoRefresh !== undefined) {
        if (typeof value.autoRefresh !== 'boolean') return { issues: [{ message: 'autoRefresh must be boolean', path: ['autoRefresh'] }] };
        out.autoRefresh = value.autoRefresh;
      }
      if (value.autoRefreshHours !== undefined) {
        if (!Number.isFinite(value.autoRefreshHours) || value.autoRefreshHours < 0) return { issues: [{ message: 'autoRefreshHours must be >= 0', path: ['autoRefreshHours'] }] };
        out.autoRefreshHours = value.autoRefreshHours;
      }
      return { value: out };
    },
  },
};

/**
 * 运行时版本与兼容判定：优先用官方 dsh-app-boot（与安装器同一份代码），拿不到再读 App 资源里的 desktop-runtime.json。
 * @returns {Promise<{runtime:string, source:string, compat?:(manifest)=>object}>}
 */
export async function resolveRuntime(config = {}) {
  if (config.runtimeVersion) return { runtime: config.runtimeVersion, source: 'config' };
  try {
    const boot = await import('@deepseek-ai/dsh-app-boot');
    const runtime = boot.getDshRuntimeVersion();
    const compat = (manifest) => {
      const peers = Object.fromEntries(Object.entries(manifest?.peerDependencies ?? {}).filter(([k]) => k === '@deepseek-ai/dsh' || k.startsWith('@deepseek-ai/dsh-')));
      if (!Object.keys(peers).length) return { status: 'none', peers, failed: {} };
      let bad;
      try { bad = boot.evaluatePluginCompatibility({ name: manifest.name || 'x', version: manifest.version || '0.0.0', peerDependencies: manifest.peerDependencies ?? {} }, {}, runtime); }
      catch { bad = { peers }; }
      return { status: bad ? 'incompatible' : 'ok', peers, failed: bad?.peers ?? {} };
    };
    return { runtime, source: '@deepseek-ai/dsh-app-boot', compat };
  } catch { /* 非 App 进程或解析不到共享包 */ }
  for (const arg of process.argv.slice(1)) {
    for (let dir = arg, i = 0; dir && i < 6; dir = dirname(dir), i++) {
      const file = join(dir, 'desktop-runtime.json');
      if (!existsSync(file)) continue;
      try { return { runtime: JSON.parse(readFileSync(file, 'utf8')).release.version, source: file }; } catch { break; }
    }
  }
  return { runtime: '0.0.0', source: 'unknown' };
}

/** GitHub token：环境变量优先，其次 `gh auth token`（经 DSH subprocess 服务）。 */
export async function resolveToken(subprocess) {
  for (const k of ['DSH_SCOUT_GITHUB_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN']) if (process.env[k]) return { token: process.env[k], source: k };
  const candidates = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh'].filter((p) => existsSync(p));
  for (const gh of candidates) {
    try {
      const handle = subprocess.spawn({ argv: [gh, 'auth', 'token', '--hostname', 'github.com'], cwd: homedir(), stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }, graceMs: 2000 });
      let out = '';
      handle.stdout?.on('data', (b) => { out += b; });
      handle.stderr?.resume?.();
      let timeout;
      const done = await Promise.race([handle.done, new Promise((r) => { timeout = setTimeout(() => r({ exitCode: -1 }), 10_000); })]).finally(() => clearTimeout(timeout));
      if (done.exitCode === -1) void handle.terminate();
      const token = out.trim();
      if (done.exitCode === 0 && /^[\w-]{20,}$/.test(token)) return { token, source: 'gh auth token' };
    } catch { /* 试下一个 */ }
  }
  return { token: undefined, source: 'none' };
}

/** 抓取与索引的状态机。单实例：同一时刻只有一次刷新。 */
export function createScout({ file, topic = 'dsh-plugin', getToken, runtime, fetch = globalThis.fetch, now = () => Date.now(), log = () => {}, publishMs = PUBLISH_MS, checkpointMs = CHECKPOINT_MS, staleBatch = NPM_STALE_BATCH }) {
  let index = emptyIndex();
  let records = [];
  let byName = new Map();
  let byRepo = new Map();
  let rev = 0;
  let job;
  let loading;
  let stopped = false;
  let writes = Promise.resolve();
  const persist = (value) => {
    const snapshot = structuredClone(value);
    const pending = writes.then(() => saveIndex(file, snapshot));
    writes = pending.catch(() => {});
    return pending;
  };
  const set = createRecordSet(() => ({ runtime: runtime.runtime, compat: runtime.compat, now: now() }));
  const state = { running: false, kind: null, progress: null, error: null, startedAt: null, cost: null, loaded: false };

  /** 把记录集的当前快照发布给接口；只做同名归并，不整库重算。 */
  const publish = () => {
    records = set.snapshot();
    byRepo = new Map(records.map((r) => [r.repo.toLowerCase(), r]));
    byName = new Map();
    for (const r of records) if (!r.shadowOf) byName.set(r.name, r);
    rev++;
  };
  const rebuild = () => { set.reset(index); publish(); };

  function load() {
    loading ??= loadIndex(file).then((i) => { index = i; rebuild(); state.loaded = true; }, (e) => { state.loaded = true; throw e; });
    return loading;
  }

  async function run(kind, controller) {
    const { signal } = controller;
    await load().catch(() => {});
    signal.throwIfAborted();
    const { token, source } = await getToken().catch(() => { throw Object.assign(new Error('GitHub 凭证服务不可用，请打开 GitHub 设置检查'), { code: 'credentials' }); });
    signal.throwIfAborted();
    if (!token) throw Object.assign(new Error('尚未配置 GitHub 认证，请打开 GitHub 设置保存 Token 或查看 gh 登录指引'), { code: 'no-token' });
    const gh = createGithub({ token, fetch, signal, onCost: (c) => { state.cost = c; } });
    const t0 = now();
    // 增量：自上次抓取前 1 天起推送过的仓库（推送会刷新 package.json，所以 pushed 比 created 更合适）。
    const since = kind === 'incremental' && index.crawledAt ? Date.parse(index.crawledAt) - DAY : undefined;
    // 原地合并：刷新期间旧索引始终可用，新到的仓库逐批覆盖进去；全量重建到结尾才剔除本轮没见到的仓库。
    const next = { ...index, repos: { ...index.repos }, npm: { ...index.npm } };
    const seen = new Set();
    const keysByName = new Map();
    const indexName = (key, fact) => {
      const n = fact?.pkg?.name;
      if (!n) return;
      if (!keysByName.has(n)) keysByName.set(n, new Set());
      keysByName.get(n).add(key);
    };
    for (const [key, fact] of Object.entries(next.repos)) indexName(key, fact);

    // npm 与 GitHub 并行：仓库一到就排队查 npm，不等 GitHub 翻完。
    const queue = [];
    const queued = new Set();
    const npmState = { done: 0, total: 0 };
    const enqueue = (n) => { if (!queued.has(n)) { queued.add(n); queue.push(n); npmState.total++; } };
    let githubDone = false;
    let dirty = false;
    const waiters = new Set();
    const wake = () => { for (const r of waiters) r(); waiters.clear(); };
    const npmWorkers = Array.from({ length: NPM_CONCURRENCY }, async () => {
      for (;;) {
        signal.throwIfAborted();
        const n = queue.shift();
        if (n === undefined) {
          if (githubDone) return;
          await new Promise((r) => {
            const done = () => { clearTimeout(timer); waiters.delete(done); r(); };
            const timer = setTimeout(done, 200);
            waiters.add(done);
          });
          continue;
        }
        const m = await npmLatest(n, { fetch, signal });
        if (m !== undefined) { next.npm[n] = { at: t0, m }; set.upsertName(n, next.repos, next.npm, keysByName); dirty = true; }
        npmState.done++;
      }
    });
    // 先挂上接收者：GitHub 一侧失败/中止时 worker 也会抛，不能变成未处理的 rejection（会带崩宿主进程）。
    const npmDone = Promise.allSettled(npmWorkers).then((results) => {
      const failed = results.find((r) => r.status === 'rejected');
      if (failed) throw failed.reason;
    });
    npmDone.catch(() => {});

    let lastPublish = now();
    let lastCheckpoint = now();
    const tick = async (force = false) => {
      const t = now();
      if (dirty && (force || t - lastPublish >= publishMs)) { publish(); dirty = false; lastPublish = t; }
      if (force || t - lastCheckpoint >= checkpointMs) {
        lastCheckpoint = t;
        // 断点：事实先落盘（crawledAt 不动），中途退出也不丢已抓到的部分，下次增量从旧水位接着补。
        await persist(next).catch((e) => log(`[scout] checkpoint failed: ${e.message}`));
      }
    };
    const report = (p) => { state.progress = { ...p, npm: { ...npmState }, tokenSource: source, published: records.length }; };

    // 已有索引时只给变动过的仓库补 package.json；冷启动没有可比对的，直接整页带 blob。
    const known = Object.keys(index.repos).length ? (key) => index.repos[key] : undefined;
    let crawled;
    try {
      crawled = await crawlRepos({
        gh, topic, since, now: t0, signal, known,
        onProgress: report,
        onBatch: (batch) => {
          for (const r of batch) {
            const key = r.repo.toLowerCase();
            const fact = factOf(r);
            const prev = next.repos[key];
            seen.add(key);
            next.repos[key] = fact;
            indexName(key, fact);
            set.upsert(key, fact, next.npm);
            // 仓库有新推送才立即重查 npm（可能刚发了版）；没变的只在 npm 条目过期时查。
            const n = fact.plugin !== false ? fact.pkg?.name : undefined;
            if (n && (prev?.pushedAt !== fact.pushedAt || !next.npm[n] || t0 - next.npm[n].at > NPM_TTL)) enqueue(n);
          }
          dirty = true;
          wake();
          void tick();
        },
      });
    } catch (e) {
      queue.length = 0;
      controller.abort(e);
      await npmDone.catch(() => {});
      throw e;
    } finally {
      githubDone = true;
      wake();
    }
    // npm 过期项按最旧优先、每轮限量补，避免某一天集中过期造成一次上万请求。
    const stale = Object.entries(next.npm).filter(([n, e]) => !queued.has(n) && t0 - e.at > NPM_TTL).sort((a, b) => a[1].at - b[1].at).slice(0, staleBatch).map(([n]) => n);
    // 从没查到过 npm 的名字（上轮失败或新出现）也补，同样限量。
    let missing = 0;
    for (const f of Object.values(next.repos)) {
      if (missing >= staleBatch) break;
      const n = f.plugin !== false ? f.pkg?.name : undefined;
      if (n && !next.npm[n] && !queued.has(n) && !stale.includes(n)) { stale.push(n); missing++; }
    }
    for (const n of stale) enqueue(n);
    const progressLoop = setInterval(() => { report({ ...state.progress, phase: 'npm', repos: crawled.size, expected: crawled.size }); void tick(); }, 500);
    try { await npmDone; } finally { clearInterval(progressLoop); }

    // npm 只提供定位线索；实际 GitHub HEAD 的 package.name 必须独立一致才能入索引。
    // 取固定快照，不对补全结果再 enqueue，避免 repository 链无限扩展。
    const candidates = new Map();
    const rechecks = new Map();
    for (const [n, entry] of Object.entries(next.npm)) {
      if (!keysByName.has(n) || entry?.m?.name !== n) continue;
      const key = canonicalGithubSlug(entry.m.repository);
      if (!key) continue;
      const cached = next.repos[key];
      const matches = cached?.plugin !== false && cached?.pkg?.name === n;
      // full 的 topic 清理不能抹去独立核验过、仍被 npm 引用的非 topic 仓库；失败或配额耗尽保留旧事实。
      if (matches) seen.add(key);
      if (matches && crawled.has(key)) continue;
      const target = matches ? rechecks : candidates;
      if (!target.has(key) && target.size < CANONICAL_BATCH) target.set(key, n);
    }
    // 缺失链优先，避免已补全仓库占满后续轮次的配额。
    for (const [key, n] of rechecks) if (candidates.size < CANONICAL_BATCH) candidates.set(key, n);
    await pool([...candidates], CANONICAL_CONCURRENCY, async ([key, n]) => {
      try {
        const repo = await gh.byRepo(key);
        if (!repo || repo.pkg?.name !== n) return;
        const fact = factOf(repo);
        if (fact.plugin === false) return;
        next.repos[key] = fact;
        seen.add(key);
        indexName(key, fact);
        set.upsert(key, fact, next.npm);
        dirty = true;
      } catch (e) {
        if (signal.aborted || e.code === 'auth' || e.code === 'rate-limit') throw e;
        // 网络/GraphQL/权限错误不证明仓库不存在，也不把 npm 内容当 GitHub 事实。
        log(`[scout] canonical lookup failed for ${key}: ${e.message}`);
      }
    }, signal);

    if (kind === 'full') {
      for (const key of Object.keys(next.repos)) if (!seen.has(key)) { delete next.repos[key]; set.remove(key); dirty = true; }
    }
    next.crawledAt = new Date(t0).toISOString();
    if (kind === 'full') next.fullAt = next.crawledAt;
    signal.throwIfAborted();
    next.succeededAt = new Date(now()).toISOString();
    // Commit the success clock only after the atomic write succeeds. Checkpoints
    // retain the previous clock and are serialized ahead of this final snapshot.
    await persist(next);
    index = next;
    publish();
    log(`[scout] ${kind} refresh: ${crawled.size} repos (${state.progress?.changed ?? '-'} changed, ${state.progress?.unchanged ?? '-'} unchanged), ${npmState.total} npm lookups, ${records.length} plugins`);
  }

  function refresh(kind) {
    if (stopped || state.running || now() < (state.retryAt ?? 0)) return false;
    const controller = new AbortController();
    Object.assign(state, { running: true, kind: kind ?? null, progress: null, error: null, startedAt: new Date(now()).toISOString() });
    const go = async () => {
      await load().catch(() => {});
      const k = kind ?? (index.fullAt ? 'incremental' : 'full');
      state.kind = k;
      await run(k, controller);
    };
    job = { controller, promise: go().catch((e) => { controller.abort(e); rebuild(); state.retryAt = e.retryAt ?? null; state.error = { code: e.code ?? 'error', message: e.message }; log(`[scout] refresh failed: ${e.message}`); }).finally(() => { state.running = false; state.progress = null; job = undefined; }) };
    return true;
  }

  return {
    load,
    refresh,
    async stop() { stopped = true; job?.controller.abort(); await job?.promise; await writes; },
    get index() { return index; },
    get records() { return records; },
    status() {
      return { ...state, rev, crawledAt: index.crawledAt, succeededAt: index.succeededAt ?? null, fullAt: index.fullAt, runtime: runtime.runtime, runtimeSource: runtime.source, repos: Object.keys(index.repos).length, facets: facets(records), categories: Object.fromEntries(Object.entries(CATEGORIES).map(([k, v]) => [k, v.label])) };
    },
    list: (params) => query(records, params),
    detail(key) {
      const r = byRepo.get(String(key).toLowerCase()) ?? byName.get(key);
      if (!r) return undefined;
      const copies = records.filter((x) => x.name === r.name && x !== r).map((x) => ({ repo: x.repo, stars: x.stars, chain: x.chain, score: x.score, pushedAt: x.pushedAt }));
      return { ...r, spec: installSpec(r), copiesList: copies.slice(0, 20) };
    },
    /** 给官方详情页的徽章：按包名查代表记录。 */
    badges(names) {
      const out = {};
      for (const n of names) {
        const r = byName.get(n);
        if (r) out[n] = { repo: r.repo, score: r.score, risky: r.risky, compat: r.compat, chain: r.chain, hooks: r.hooks, provenance: r.provenance, npmVersion: r.npmVersion, checks: r.checks, cats: r.cats.map((c) => c.id), spec: installSpec(r) };
      }
      return out;
    },
    /** 测试用：直接注入索引。 */
    _set(next) { index = next; rebuild(); state.loaded = true; loading = Promise.resolve(); },
  };
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req, limit = 256_000) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(c);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 500) : typeof v === 'string' && v ? v.split(',').slice(0, 50) : []);

/** 路由。所有接口都要求自定义头（CSRF 意图）+ DSH connection.admit（Host/Origin 栅栏 + 浏览器认证）。 */
export function createHandler(scout, { admit, auth }) {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.slice(PREFIX.length) || '/';
    if (req.headers['x-dsh-plugin-scout'] !== '1') return send(res, 403, { ok: false, error: { code: 'forbidden', message: 'missing intent header' } });
    const admission = admit(req);
    if (!admission || admission.rejection !== undefined || !admission.peer) return send(res, admission?.rejection ?? 403, { ok: false, error: { code: 'forbidden', message: 'DSH 认证失败，请重新打开应用' } });
    if (path === '/api/auth') {
      if (admission.peer.principal?.kind !== 'owner') return send(res, 403, { ok: false, error: { code: 'forbidden', message: '仅主人可管理 GitHub 认证' } });
      try {
        if (!auth) return send(res, 503, { ok: false, error: { code: 'unavailable', message: 'GitHub 设置尚未就绪，请重启 DSH' } });
        if (req.method === 'GET') return send(res, 200, { ok: true, value: await auth.run() });
        if (req.method !== 'POST') return send(res, 405, { ok: false, error: { code: 'method', message: '不支持的请求' } });
        let b;
        try { b = await readJson(req, 8192); } catch (e) { return send(res, e.status === 413 ? 413 : 400, { ok: false, error: { code: 'bad-request', message: '认证请求格式错误或过大' } }); }
        if (!b || typeof b !== 'object' || Array.isArray(b) || !['save', 'clear', 'check'].includes(b.action)) return send(res, 400, { ok: false, error: { code: 'bad-request', message: '不支持的认证操作' } });
        return send(res, 200, { ok: true, value: await auth.run(b.action, b.token) });
      } catch (e) {
        return send(res, [400, 409, 503].includes(e.status) ? e.status : 503, { ok: false, error: { code: 'auth-error', message: 'GitHub 设置操作失败，请检查 Token 或凭证服务后重试' } });
      }
    }
    try {
      if (req.method === 'GET' && path === '/api/status') return send(res, 200, { ok: true, value: scout.status() });
      if (req.method === 'POST' && path === '/api/list') {
        const b = await readJson(req);
        return send(res, 200, { ok: true, value: scout.list({ q: typeof b.q === 'string' ? b.q.slice(0, 200) : '', cat: typeof b.cat === 'string' ? b.cat : 'all', sort: b.sort, compat: list(b.compat), flags: list(b.flags), inst: b.inst, installed: list(b.installed), offset: b.offset, limit: b.limit }) });
      }
      if (req.method === 'GET' && path === '/api/detail') {
        const d = scout.detail(url.searchParams.get('key') ?? '');
        return d ? send(res, 200, { ok: true, value: d }) : send(res, 404, { ok: false, error: { code: 'not-found', message: '索引里没有这个插件' } });
      }
      if (req.method === 'POST' && path === '/api/badges') {
        const b = await readJson(req);
        return send(res, 200, { ok: true, value: scout.badges(list(b.names)) });
      }
      if (req.method === 'POST' && path === '/api/refresh') {
        const b = await readJson(req);
        const started = scout.refresh(b.full === true ? 'full' : undefined);
        const status = scout.status();
        const cooling = status.retryAt > Date.now();
        return send(res, started ? 202 : cooling ? 429 : 409, { ok: started, value: status, ...(started ? {} : { error: { code: cooling ? 'rate-limit' : 'busy', message: cooling ? 'GitHub 限流冷却中，请稍后重试' : '已有刷新在进行' } }) });
      }
      return send(res, 404, { ok: false, error: { code: 'not-found', message: path } });
    } catch (e) {
      return send(res, e.status ?? 500, { ok: false, error: { code: 'error', message: e.message } });
    }
  };
}

/** Only register behind connection.fetch: the shared carrier authenticates owner peers. */
export function registerScoutRoutes(connection, scout, auth) {
  const handler = createHandler(scout, { auth, admit: () => ({ peer: { principal: { kind: 'owner' } } }) });
  const endpoints = { status: ['GET'], list: ['POST'], detail: ['GET'], badges: ['POST'], refresh: ['POST'], auth: ['GET', 'POST'] };
  const disposers = Object.entries(endpoints).map(([endpoint, methods]) => connection.fetch.register({
    path: `${PREFIX}/api/${endpoint}`, methods, requestBody: methods.includes('GET') ? 'buffered' : 'streaming',
    async fetch(request) {
      const req = request.body ? Readable.fromWeb(request.body) : Readable.from([]);
      req.method = request.method;
      req.url = request.url;
      req.headers = Object.fromEntries(request.headers);
      let status = 500, headers = {}, body = '';
      await handler(req, { writeHead(s, h) { status = s; headers = h; }, end(b) { body = b; } });
      return new Response(body, { status, headers });
    },
  }));
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}

export async function apply(ctx, config = {}) {
  const dataDir = config.dataDir || join(homedir(), '.dsh', 'dsh-plugin-scout');
  const runtime = await resolveRuntime(config);
  const log = (m) => ctx.logger?.info?.(m) ?? ctx.logger?.warn?.(m);
  const auth = createAuth({ credentials: ctx.get?.('credentials') ?? ctx.credentials, fallback: () => resolveToken(ctx.subprocess) });
  const scout = createScout({ file: join(dataDir, 'index.json'), topic: config.topic, runtime, getToken: () => auth.resolve(), log });
  // 不在激活路径上读 30MB 索引：后台加载，界面先拿到 loaded:false 再自行轮询。
  scout.load().catch((e) => ctx.logger?.warn?.(`[scout] index unreadable, starting empty: ${e.message}`));
  ctx.effect(() => {
    const dispose = registerScoutRoutes(ctx.connection ?? ctx.get?.('connection'), scout, auth);
    // 进程内定时：App 运行时才跑，不设 LaunchAgent/外部调度器。
    const stopAutoRefresh = startAutoRefresh(scout, { enabled: config.autoRefresh ?? true, hours: config.autoRefreshHours ?? 1 });
    return async () => {
      stopAutoRefresh();
      dispose();
      await scout.stop();
    };
  }, 'dsh-plugin-scout: host routes and refresh');
}
