// 抓取：GitHub GraphQL search（topic:dsh-plugin）一次拿回仓库元数据 + HEAD:package.json + HEAD:cordis.patch.yml。
// 单个 search 最多翻 1000 条，所以按时间自适应切窗；100 条一页在爆量时段会 502，默认 50，失败再降到 25。
// 只读：只发 GET/POST 查询，不写 GitHub、不克隆、不执行任何仓库内容。

const GQL = 'https://api.github.com/graphql';
const NPM = 'https://registry.npmjs.org';
const WINDOW_CAP = 900;
const MIN_SPAN = 60_000;
const EPOCH = Date.parse('2008-01-01T00:00:00Z');

const FULL_FIELDS = `nameWithOwner description stargazerCount pushedAt createdAt isArchived isFork
   licenseInfo{spdxId} repositoryTopics(first:20){nodes{topic{name}}}
   pkg:object(expression:"HEAD:package.json"){ ... on Blob{ text } }
   patch:object(expression:"HEAD:cordis.patch.yml"){ ... on Blob{ text byteSize } }`;
const QUERY = `query($q:String!,$after:String,$n:Int!){ rateLimit{cost remaining resetAt}
 search(type:REPOSITORY,query:$q,first:$n,after:$after){ repositoryCount pageInfo{hasNextPage endCursor}
  nodes{ ... on Repository{ ${FULL_FIELDS} } } } }`;
/** 轻查询：只要元数据，不读 blob；100 条一页约 4s（带 blob 的 50 条一页约 6s）。 */
const LIGHT = `query($q:String!,$after:String,$n:Int!){ rateLimit{cost remaining resetAt}
 search(type:REPOSITORY,query:$q,first:$n,after:$after){ repositoryCount pageInfo{hasNextPage endCursor}
  nodes{ ... on Repository{ id nameWithOwner description stargazerCount pushedAt createdAt isArchived isFork licenseInfo{spdxId} } } } }`;
/** 只给变动过的仓库补 blob。 */
const BY_IDS = `query($ids:[ID!]!){ rateLimit{cost remaining resetAt} nodes(ids:$ids){ ... on Repository{ ${FULL_FIELDS} } } }`;
const BLOB_CHUNK = 50;
const COUNT = 'query($q:String!){ search(type:REPOSITORY,query:$q,first:1){ repositoryCount } }';

const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
const sleep = (ms, signal) => new Promise((res, rej) => {
  const h = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(h); rej(signal.reason ?? new Error('aborted')); }, { once: true });
});

/** 只保留核验与分类要用的 package.json 字段，索引体积降一个量级。 */
export function slimManifest(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return undefined;
  const pick = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? o : undefined);
  const hooks = {};
  for (const h of ['preinstall', 'install', 'postinstall', 'prepare']) if (typeof p.scripts?.[h] === 'string') hooks[h] = p.scripts[h].slice(0, 200);
  const dsh = pick(p.dsh);
  return {
    name: typeof p.name === 'string' ? p.name : undefined,
    version: typeof p.version === 'string' ? p.version : undefined,
    description: typeof p.description === 'string' ? p.description.slice(0, 400) : undefined,
    keywords: Array.isArray(p.keywords) ? p.keywords.filter((k) => typeof k === 'string').slice(0, 30) : undefined,
    repository: typeof p.repository === 'string' ? p.repository : pick(p.repository) ? { url: p.repository.url } : undefined,
    scripts: hooks,
    dependencies: pick(p.dependencies) ? Object.fromEntries(Object.keys(p.dependencies).slice(0, 200).map((k) => [k, ''])) : undefined,
    peerDependencies: pick(p.peerDependencies),
    dsh: dsh ? { ...Object.fromEntries(Object.keys(dsh).map((k) => [k, true])), bundle: dsh.bundle ? true : undefined, client: dsh.client ? { inject: Array.isArray(dsh.client.inject) ? dsh.client.inject.slice(0, 40) : undefined } : undefined } : undefined,
    dist: p.dist ? { attestations: !!p.dist.attestations } : undefined,
  };
}

/** GraphQL 节点 → 仓库事实。package.json 解析失败视为没有。 */
export function normalizeNode(n) {
  if (!n?.nameWithOwner) return undefined;
  let pkg;
  try { pkg = n.pkg?.text ? slimManifest(JSON.parse(n.pkg.text)) : undefined; } catch { pkg = undefined; }
  return {
    repo: n.nameWithOwner,
    description: n.description ?? '',
    stars: n.stargazerCount ?? 0,
    pushedAt: n.pushedAt,
    createdAt: n.createdAt,
    archived: !!n.isArchived,
    fork: !!n.isFork,
    license: n.licenseInfo?.spdxId ?? null,
    topics: (n.repositoryTopics?.nodes ?? []).map((t) => t?.topic?.name).filter(Boolean),
    pkg,
    patchText: typeof n.patch?.text === 'string' && n.patch.byteSize < 64_000 ? n.patch.text : undefined,
  };
}

export function createGithub({ token, fetch = globalThis.fetch, signal, onCost }) {
  async function gql(query, variables, attempt = 0) {
    const res = await fetch(GQL, {
      method: 'POST', signal,
      headers: { authorization: `bearer ${token}`, 'content-type': 'application/json', 'user-agent': 'dsh-plugin-scout' },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 401) throw Object.assign(new Error('GitHub token 无效或已过期'), { code: 'auth' });
    if ((res.status === 403 || res.status === 429) && attempt < 4) {
      const wait = Number(res.headers.get('retry-after')) * 1000 || 60_000;
      await sleep(Math.min(wait, 300_000), signal);
      return gql(query, variables, attempt + 1);
    }
    if (res.status >= 500) throw Object.assign(new Error(`GitHub ${res.status}`), { code: 'upstream', status: res.status });
    const body = await res.json();
    if (body.errors?.length && !body.data) throw Object.assign(new Error(body.errors[0].message), { code: 'graphql' });
    if (body.data?.rateLimit) onCost?.(body.data.rateLimit);
    return body.data;
  }
  return {
    async count(q) { return (await gql(COUNT, { q })).search.repositoryCount; },
    /** 翻完一个窗口；502 时按页长逐级降（50 → 25 → 10），同一游标续翻。light=true 只拿元数据、100 条一页。 */
    async *pages(q, { light = false } = {}) {
      let after = null;
      let n = light ? 100 : 50;
      for (;;) {
        let data;
        try { data = await gql(light ? LIGHT : QUERY, { q, after, n }); }
        catch (e) {
          if (e.code === 'upstream' && n > 10) { n = n > 50 ? 50 : n === 50 ? 25 : 10; continue; }
          throw e;
        }
        yield data.search.nodes;
        if (!data.search.pageInfo.hasNextPage) return;
        after = data.search.pageInfo.endCursor;
      }
    },
    /** 按 node id 取完整节点（含 package.json / patch）。502 时对半拆开重试。 */
    async byIds(ids) {
      try { return (await gql(BY_IDS, { ids })).nodes ?? []; }
      catch (e) {
        if (e.code !== 'upstream' || ids.length <= 5) throw e;
        const h = Math.ceil(ids.length / 2);
        return [...await this.byIds(ids.slice(0, h)), ...await this.byIds(ids.slice(h))];
      }
    },
  };
}

/** 几何播种：先切出「近 6 小时 / 1 天 / 3 天 / 1 周 / 1 月 / 3 月 / 更早」，最新一段几乎不用二分就能开翻。 */
const SEEDS = [6 * 3_600_000, 86_400_000, 3 * 86_400_000, 7 * 86_400_000, 30 * 86_400_000, 90 * 86_400_000];
export function seedSpans(from, to) {
  const cuts = SEEDS.map((d) => to - d).filter((t) => t > from);
  const bounds = [from, ...cuts.reverse(), to];
  const spans = [];
  for (let i = 0; i < bounds.length - 1; i++) spans.push([i ? bounds[i] + 1000 : bounds[i], bounds[i + 1]]);
  return spans; // 旧 → 新
}

/**
 * 自适应切窗：数量超过 WINDOW_CAP 就二分时间，直到每窗都能完整翻完。
 * 新的时间段先出：界面边抓边发布时，最近活跃的仓库最先可见。
 * @param {'created'|'pushed'} field
 */
export async function* windows(gh, topic, field, from, to) {
  const stack = seedSpans(from, to);
  while (stack.length) {
    const [a, b] = stack.pop();
    const q = `topic:${topic} ${field}:${iso(a)}..${iso(b)}`;
    const count = await gh.count(q);
    if (!count) continue;
    if (count > WINDOW_CAP && b - a > MIN_SPAN) {
      const mid = a + Math.floor((b - a) / 2);
      stack.push([a, mid], [mid + 1000, b]);
      continue;
    }
    yield { q, count };
  }
}

/** 轻节点 + 已知事实 → 不变则只刷新元数据（不再下载 package.json）。 */
function refreshMeta(known, n) {
  if (known.plugin === false) return { ...known, pushedAt: n.pushedAt };
  return { ...known, description: n.description ?? '', stars: n.stargazerCount ?? 0, pushedAt: n.pushedAt, createdAt: n.createdAt, archived: !!n.isArchived, fork: !!n.isFork, license: n.licenseInfo?.spdxId ?? null };
}

/**
 * 抓取 topic 下所有（或某时间点后推送过的）仓库。流式：切窗与翻页并行，每页一到就交给 onBatch，
 * 不等全部窗口算完、也不等全部翻完——首批结果几秒内可见。
 * 给了 known（已有索引）时走「轻查询 + 按需补 blob」：pushedAt 没变的仓库不再下载 package.json，
 * 刷新成本只随「变化量」增长，而不是随插件总数增长。
 * @param {{gh, topic?:string, since?:number, now?:number, known?:(key:string)=>object|undefined, onProgress?:(p)=>void, onBatch?:(repos:object[])=>void, signal?:AbortSignal}} o
 * @returns {Promise<Map<string, object>>} key = 小写 owner/name
 */
export async function crawlRepos({ gh, topic = 'dsh-plugin', since, now = Date.now(), known, onProgress, onBatch, signal }) {
  const field = since ? 'pushed' : 'created';
  const from = since ?? EPOCH;
  const out = new Map();
  const stats = { changed: 0, unchanged: 0 };
  // 总数只用于进度分母：不等它，和切窗、翻页同时跑。
  let expected = 0;
  const totalQ = gh.count(`topic:${topic} ${field}:${iso(from)}..${iso(now)}`).then((n) => { expected = n; report(); }, (e) => { if (e.code === 'auth') throw e; });
  let windowsDone = 0;
  let windowsSeen = 0;
  const report = () => onProgress?.({ phase: 'github', repos: out.size, expected, windows: windowsDone, totalWindows: windowsSeen, ...stats });
  report();
  async function* seen() { for await (const w of windows(gh, topic, field, from, now)) { windowsSeen++; yield w; } }
  const emit = (facts) => {
    const batch = [];
    for (const r of facts) if (r) { out.set(r.repo.toLowerCase(), r); batch.push(r); }
    if (batch.length) onBatch?.(batch);
    report();
  };
  // 3 路并发：搜索 API 对并发敏感，再多容易触发二级限流。
  await poolIter(seen(), 3, async (w) => {
    for await (const nodes of gh.pages(w.q, { light: !!known })) {
      signal?.throwIfAborted();
      if (!known) { emit(nodes.map(normalizeNode)); continue; }
      const same = [];
      const ids = [];
      for (const n of nodes) {
        if (!n?.nameWithOwner) continue;
        const k = known(n.nameWithOwner.toLowerCase());
        if (k && k.pushedAt === n.pushedAt) same.push(refreshMeta(k, n));
        else if (n.id) ids.push(n.id);
      }
      stats.unchanged += same.length;
      emit(same);
      for (let i = 0; i < ids.length; i += BLOB_CHUNK) {
        signal?.throwIfAborted();
        const full = (await gh.byIds(ids.slice(i, i + BLOB_CHUNK))).map(normalizeNode).filter(Boolean);
        stats.changed += full.length;
        emit(full);
      }
    }
    windowsDone++;
    report();
  }, signal);
  await totalQ;
  return out;
}

/** 对异步迭代器做有限并发 map：生产者（切窗）与消费者（翻页）重叠执行。 */
export async function poolIter(iterable, size, fn, signal) {
  const it = iterable[Symbol.asyncIterator]();
  let pulling = Promise.resolve();
  let finished = false;
  const next = () => {
    const p = pulling.then(async () => (finished ? { done: true } : it.next()));
    pulling = p.then((r) => { if (r.done) finished = true; }, () => { finished = true; });
    return p;
  };
  const workers = Array.from({ length: size }, async () => {
    for (;;) {
      signal?.throwIfAborted();
      const r = await next();
      if (r.done) return;
      await fn(r.value);
    }
  });
  await Promise.all(workers);
}

/** npm `/<name>/latest`：200 → 精简清单，404 → null，其它错误 → undefined（下次再查）。 */
export async function npmLatest(name, { fetch = globalThis.fetch, signal } = {}) {
  if (typeof name !== 'string' || !/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(name) || name.length > 214) return null;
  const path = name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
  try {
    const res = await fetch(`${NPM}/${path}/latest`, { signal, headers: { accept: 'application/json', 'user-agent': 'dsh-plugin-scout' } });
    if (res.status === 404) return null;
    if (!res.ok) return undefined;
    return slimManifest(await res.json());
  } catch (e) {
    if (signal?.aborted) throw e;
    return undefined;
  }
}

/** 有限并发 map。 */
export async function pool(items, size, fn, signal) {
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      signal?.throwIfAborted();
      const k = i++;
      await fn(items[k], k);
    }
  });
  await Promise.all(workers);
}
