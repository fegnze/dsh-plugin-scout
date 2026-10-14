// DSH Plugin Scout — Host 半边。
// 职责：抓 GitHub topic:dsh-plugin + npm，存事实索引，按需现算核验，经 DSH 自己的 webServer 同源提供只读接口。
// 边界：不安装、不卸载、不启用任何插件（那是官方插件页的事）；不起常驻进程，子进程只用于 `gh auth token`，走 subprocess 服务。
import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { crawlRepos, createGithub, npmLatest, pool } from './core/crawl.mjs';
import { deriveRecords, emptyIndex, facets, factOf, loadIndex, query, saveIndex } from './core/store.mjs';
import { CATEGORIES } from './core/classify.mjs';
import { installSpec } from './core/verify.mjs';

export const name = 'dsh-plugin-scout';
export const inject = ['webServer', 'subprocess'];

export const PREFIX = '/dsh-plugin-scout';
const DAY = 86_400_000;
const NPM_TTL = DAY;
const AUTO_DELAY = 45_000;

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
      if (value.autoRefreshHours !== undefined) {
        if (typeof value.autoRefreshHours !== 'number' || value.autoRefreshHours < 0) return { issues: [{ message: 'autoRefreshHours must be >= 0', path: ['autoRefreshHours'] }] };
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
      const done = await Promise.race([handle.done, new Promise((r) => setTimeout(() => r({ exitCode: -1 }), 10_000))]);
      if (done.exitCode === -1) void handle.terminate();
      const token = out.trim();
      if (done.exitCode === 0 && /^[\w-]{20,}$/.test(token)) return { token, source: 'gh auth token' };
    } catch { /* 试下一个 */ }
  }
  return { token: undefined, source: 'none' };
}

/** 抓取与索引的状态机。单实例：同一时刻只有一次刷新。 */
export function createScout({ file, topic = 'dsh-plugin', getToken, runtime, fetch = globalThis.fetch, now = () => Date.now(), log = () => {} }) {
  let index = emptyIndex();
  let records = [];
  let byName = new Map();
  let byRepo = new Map();
  let job;
  const state = { running: false, kind: null, progress: null, error: null, startedAt: null, cost: null };

  const rebuild = () => {
    records = deriveRecords(index, { runtime: runtime.runtime, compat: runtime.compat, now: now() });
    byRepo = new Map(records.map((r) => [r.repo.toLowerCase(), r]));
    byName = new Map();
    for (const r of records) if (!r.shadowOf) byName.set(r.name, r);
  };

  async function load() {
    index = await loadIndex(file);
    rebuild();
  }

  async function run(kind, signal) {
    const { token, source } = await getToken();
    if (!token) throw Object.assign(new Error('没有 GitHub token：请先在终端执行 `gh auth login`，或设置 GITHUB_TOKEN'), { code: 'no-token' });
    const gh = createGithub({ token, fetch, signal, onCost: (c) => { state.cost = c; } });
    const t0 = now();
    // 增量：自上次抓取前 1 天起推送过的仓库（推送会刷新 package.json，所以 pushed 比 created 更合适）。
    const since = kind === 'incremental' && index.crawledAt ? Date.parse(index.crawledAt) - DAY : undefined;
    const repos = await crawlRepos({ gh, topic, since, now: t0, signal, onProgress: (p) => { state.progress = { ...p, tokenSource: source }; } });
    const next = kind === 'full' ? { ...emptyIndex(), npm: index.npm } : { ...index, repos: { ...index.repos } };
    for (const [key, r] of repos) next.repos[key] = factOf(r);
    // npm：本轮触及的插件名，加上缓存过期的名字。
    const touched = new Set();
    for (const r of repos.values()) if (r.pkg?.name && r.pkg.dsh) touched.add(r.pkg.name);
    for (const f of Object.values(next.repos)) if (f.pkg?.name && (!next.npm[f.pkg.name] || t0 - next.npm[f.pkg.name].at > NPM_TTL * 7)) touched.add(f.pkg.name);
    const names = [...touched];
    let npmDone = 0;
    state.progress = { phase: 'npm', done: 0, total: names.length };
    await pool(names, 8, async (n) => {
      const m = await npmLatest(n, { fetch, signal });
      if (m !== undefined) next.npm[n] = { at: t0, m };
      state.progress = { phase: 'npm', done: ++npmDone, total: names.length };
    }, signal);
    next.crawledAt = new Date(t0).toISOString();
    if (kind === 'full') next.fullAt = next.crawledAt;
    await saveIndex(file, next);
    index = next;
    rebuild();
    log(`[scout] ${kind} refresh: ${repos.size} repos, ${names.length} npm lookups, ${records.length} plugins`);
  }

  function refresh(kind = index.fullAt ? 'incremental' : 'full') {
    if (state.running) return false;
    const controller = new AbortController();
    Object.assign(state, { running: true, kind, progress: null, error: null, startedAt: new Date(now()).toISOString() });
    job = { controller, promise: run(kind, controller.signal).catch((e) => { state.error = { code: e.code ?? 'error', message: e.message }; log(`[scout] refresh failed: ${e.message}`); }).finally(() => { state.running = false; state.progress = null; job = undefined; }) };
    return true;
  }

  return {
    load,
    refresh,
    async stop() { job?.controller.abort(); await job?.promise; },
    get index() { return index; },
    get records() { return records; },
    status() {
      return { ...state, crawledAt: index.crawledAt, fullAt: index.fullAt, runtime: runtime.runtime, runtimeSource: runtime.source, repos: Object.keys(index.repos).length, facets: facets(records), categories: Object.fromEntries(Object.entries(CATEGORIES).map(([k, v]) => [k, v.label])) };
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
    _set(next) { index = next; rebuild(); },
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
export function createHandler(scout, { admit }) {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.slice(PREFIX.length) || '/';
    if (req.headers['x-dsh-plugin-scout'] !== '1') return send(res, 403, { ok: false, error: { code: 'forbidden', message: 'missing intent header' } });
    const admission = admit(req);
    if (!admission || admission.rejection !== undefined || !admission.peer) return send(res, admission?.rejection ?? 403, { ok: false, error: { code: 'forbidden', message: 'DSH 认证失败，请重新打开应用' } });
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
        return send(res, started ? 202 : 409, { ok: started, value: scout.status(), ...(started ? {} : { error: { code: 'busy', message: '已有刷新在进行' } }) });
      }
      return send(res, 404, { ok: false, error: { code: 'not-found', message: path } });
    } catch (e) {
      return send(res, e.status ?? 500, { ok: false, error: { code: 'error', message: e.message } });
    }
  };
}

export async function apply(ctx, config = {}) {
  const dataDir = config.dataDir || join(homedir(), '.dsh', 'dsh-plugin-scout');
  const runtime = await resolveRuntime(config);
  const log = (m) => ctx.logger?.info?.(m) ?? ctx.logger?.warn?.(m);
  const scout = createScout({ file: join(dataDir, 'index.json'), topic: config.topic, runtime, getToken: () => resolveToken(ctx.subprocess), log });
  try { await scout.load(); } catch (e) { ctx.logger?.warn?.(`[scout] index unreadable, starting empty: ${e.message}`); }
  const admit = (req) => {
    const connection = ctx.get?.('connection');
    return typeof connection?.admit === 'function' ? connection.admit(req) : undefined;
  };
  ctx.effect(() => {
    const dispose = ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler: createHandler(scout, { admit }) });
    // 进程内定时：App 运行时才跑，不设 LaunchAgent/外部调度器。
    const hours = config.autoRefreshHours ?? 24;
    let timer;
    const tick = () => {
      const last = scout.index.crawledAt ? Date.parse(scout.index.crawledAt) : 0;
      if (hours > 0 && Date.now() - last > hours * 3_600_000) scout.refresh();
      if (hours > 0) timer = setTimeout(tick, Math.min(hours * 3_600_000, 6 * 3_600_000));
    };
    timer = setTimeout(tick, AUTO_DELAY);
    return async () => {
      clearTimeout(timer);
      dispose();
      await scout.stop();
    };
  }, 'dsh-plugin-scout: host routes and refresh');
}
