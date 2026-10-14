// 抓取：GitHub GraphQL search（topic:dsh-plugin）一次拿回仓库元数据 + HEAD:package.json + HEAD:cordis.patch.yml。
// 单个 search 最多翻 1000 条，所以按时间自适应切窗；100 条一页在爆量时段会 502，默认 50，失败再降到 25。
// 只读：只发 GET/POST 查询，不写 GitHub、不克隆、不执行任何仓库内容。

const GQL = 'https://api.github.com/graphql';
const NPM = 'https://registry.npmjs.org';
const WINDOW_CAP = 900;
const MIN_SPAN = 60_000;
const EPOCH = Date.parse('2008-01-01T00:00:00Z');

const QUERY = `query($q:String!,$after:String,$n:Int!){ rateLimit{cost remaining resetAt}
 search(type:REPOSITORY,query:$q,first:$n,after:$after){ repositoryCount pageInfo{hasNextPage endCursor}
  nodes{ ... on Repository{ nameWithOwner description stargazerCount pushedAt createdAt isArchived isFork
   licenseInfo{spdxId} repositoryTopics(first:20){nodes{topic{name}}}
   pkg:object(expression:"HEAD:package.json"){ ... on Blob{ text } }
   patch:object(expression:"HEAD:cordis.patch.yml"){ ... on Blob{ text byteSize } } } } } }`;
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
    /** 翻完一个窗口；502 时按 50 → 25 → 10 降页，同一游标续翻。 */
    async *pages(q) {
      let after = null;
      let n = 50;
      for (;;) {
        let data;
        try { data = await gql(QUERY, { q, after, n }); }
        catch (e) {
          if (e.code === 'upstream' && n > 10) { n = n === 50 ? 25 : 10; continue; }
          throw e;
        }
        yield data.search.nodes;
        if (!data.search.pageInfo.hasNextPage) return;
        after = data.search.pageInfo.endCursor;
      }
    },
  };
}

/**
 * 自适应切窗：数量超过 WINDOW_CAP 就二分时间，直到每窗都能完整翻完。
 * @param {'created'|'pushed'} field
 */
export async function* windows(gh, topic, field, from, to) {
  const stack = [[from, to]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const q = `topic:${topic} ${field}:${iso(a)}..${iso(b)}`;
    const count = await gh.count(q);
    if (!count) continue;
    if (count > WINDOW_CAP && b - a > MIN_SPAN) {
      const mid = a + Math.floor((b - a) / 2);
      stack.push([mid + 1000, b], [a, mid]);
      continue;
    }
    yield { q, count };
  }
}

/**
 * 抓取 topic 下所有（或某时间点后推送过的）仓库。
 * @param {{gh, topic?:string, since?:number, now?:number, onProgress?:(p)=>void, signal?:AbortSignal}} o
 * @returns {Promise<Map<string, object>>} key = 小写 owner/name
 */
export async function crawlRepos({ gh, topic = 'dsh-plugin', since, now = Date.now(), onProgress, signal }) {
  const field = since ? 'pushed' : 'created';
  const out = new Map();
  const list = [];
  for await (const w of windows(gh, topic, field, since ?? EPOCH, now)) {
    signal?.throwIfAborted();
    list.push(w);
  }
  const expected = list.reduce((a, w) => a + w.count, 0);
  let done = 0;
  onProgress?.({ phase: 'github', repos: 0, expected, windows: 0, totalWindows: list.length });
  // 3 路并发：搜索 API 对并发敏感，再多容易触发二级限流。
  await pool(list, 3, async (w) => {
    for await (const nodes of gh.pages(w.q)) {
      signal?.throwIfAborted();
      for (const n of nodes) {
        const r = normalizeNode(n);
        if (r) out.set(r.repo.toLowerCase(), r);
      }
      onProgress?.({ phase: 'github', repos: out.size, expected, windows: done, totalWindows: list.length });
    }
    done++;
  }, signal);
  return out;
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
