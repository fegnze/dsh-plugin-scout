// 核验与可信度：纯函数，输入是抓取到的事实，输出是可解释的判定。只读，不安装、不执行任何东西。
// V2 复刻官方规则（@deepseek-ai/dsh-app-boot evaluatePluginCompatibility）：
//   只看 peerDependencies 里 @deepseek-ai/dsh 与 @deepseek-ai/dsh-* 的范围；
//   semver.satisfies(runtime, range, { includePrerelease: true })；workspace:^/~/* 视为当前运行时；
//   空范围或非法范围 = 不兼容；没有 DSH peer = 不约束。
import semver from 'semver';
import { classify } from './classify.mjs';

const HOOKS = ['preinstall', 'install', 'postinstall', 'prepare'];
const DAY = 86_400_000;

/** 把 package.json 的 repository 字段规整成 `owner/name`（小写）；不是 GitHub 则返回 undefined。 */
export function githubSlug(repository) {
  const raw = typeof repository === 'string' ? repository : repository?.url;
  if (typeof raw !== 'string') return undefined;
  const m = raw.trim().match(/^(?:github:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:#.*)?$/i)
    ?? raw.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[#/?].*)?$/i);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : undefined;
}

/** 是不是 DSH 插件：package.json 有 dsh 对象且声明了 bundle 或 client。 */
export function pluginKinds(pkg) {
  const dsh = pkg && typeof pkg.dsh === 'object' && !Array.isArray(pkg.dsh) ? pkg.dsh : undefined;
  if (!dsh) return [];
  return [dsh.bundle && 'bundle', dsh.client && 'client'].filter(Boolean);
}

/**
 * 官方兼容规则的独立实现（宿主可用官方函数时优先用官方的，见 host.mjs）。
 * @returns {{status:'none'|'ok'|'incompatible', peers:Record<string,string>, failed:Record<string,string>}}
 */
export function compatibility(manifest, runtime) {
  const peers = {};
  const failed = {};
  for (const [name, range] of Object.entries(manifest?.peerDependencies ?? {})) {
    if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue;
    peers[name] = range;
    const req = ['workspace:^', 'workspace:~', 'workspace:*'].includes(range) ? runtime : range;
    let ok = false;
    try { ok = typeof req === 'string' && req.trim() !== '' && semver.satisfies(runtime, req, { includePrerelease: true }); } catch { ok = false; }
    if (!ok) failed[name] = range;
  }
  if (!Object.keys(peers).length) return { status: 'none', peers, failed };
  return { status: Object.keys(failed).length ? 'incompatible' : 'ok', peers, failed };
}

/** cordis.patch.yml 中 insert 的模块名（只做文本提取，不执行 YAML 标签）。 */
export function patchInserts(text) {
  if (typeof text !== 'string') return [];
  const names = new Set();
  for (const m of text.matchAll(/^\s*-?\s*name:\s*['"]?([^'"\s#]+)['"]?/gm)) names.add(m[1]);
  return [...names].slice(0, 40);
}

/**
 * 一条仓库事实 → 一条插件记录。不是插件返回 undefined。
 * @param {object} repo GraphQL 节点（已规整）：{ repo, description, stars, pushedAt, createdAt, archived, fork, license, topics, pkg, patchText }
 * @param {object|null|undefined} npm npm `/<name>/latest` 清单；null = 未发布；undefined = 未查询
 * @param {{runtime:string, now?:number, compat?:(manifest)=>object}} env
 */
export function evaluate(repo, npm, env) {
  const pkg = repo.pkg;
  const kinds = pluginKinds(pkg);
  if (!kinds.length) return undefined;
  const now = env.now ?? Date.now();
  const runtime = env.runtime;
  const slug = repo.repo.toLowerCase();
  const published = npm && typeof npm === 'object';
  // 用户实际装到的是 npm 上的版本：兼容与脚本以 npm 清单为准，未发布才看仓库。
  const manifest = published ? npm : pkg;
  const checks = [];
  const add = (id, st, text, ev) => checks.push({ id, st, text, ev });

  add('V1', 'ok', `真插件：package.json 声明 dsh.${kinds.join(' + ')}`, `dsh: { ${Object.keys(pkg.dsh).join(', ')} }`);

  const compat = (env.compat ?? ((m) => compatibility(m, runtime)))(manifest);
  const peerText = Object.entries(compat.peers).map(([k, v]) => `${k}@${v}`).join(', ');
  if (compat.status === 'ok') add('V2', 'ok', `DSH peer 范围覆盖当前运行时 ${runtime}`, peerText);
  else if (compat.status === 'incompatible') add('V2', 'warn', `DSH peer 不覆盖 ${runtime}：官方安装器会在 pnpm 运行前拒装，需逐版本豁免`, Object.entries(compat.failed).map(([k, v]) => `${k}@${v}`).join(', '));
  else add('V2', 'unk', '未声明 DSH peer，官方不做版本约束', 'peerDependencies 中无 @deepseek-ai/dsh*');

  const scripts = { ...(pkg.scripts ?? {}), ...(published ? npm.scripts ?? {} : {}) };
  const hooks = HOOKS.filter((h) => typeof scripts[h] === 'string' && scripts[h].trim());
  if (hooks.length) add('V3', 'bad', '含安装期脚本：获准后以你的用户权限在沙箱外执行', hooks.map((h) => `${h}: ${String(scripts[h]).slice(0, 80)}`).join(' · '));
  else add('V3', 'ok', '无安装期脚本', `scripts 中无 ${HOOKS.join('/')}`);

  const npmSlug = published ? githubSlug(npm.repository) : undefined;
  const chain = !published ? (npm === null ? 'unpublished' : 'unknown') : npmSlug === slug ? 'match' : 'mismatch';
  if (chain === 'unpublished') add('V4', 'warn', '未发布 npm，只能按 Git 地址安装', `registry.npmjs.org/${pkg.name} → 404`);
  else if (chain === 'unknown') add('V4', 'unk', 'npm 尚未查询', '下次刷新补全');
  else if (chain === 'match') add('V4', 'ok', 'npm 包的 repository 指回本仓库', `${pkg.name}@${npm.version} → github.com/${npmSlug}`);
  else add('V4', 'bad', 'npm 同名包的 repository 不指向本仓库（副本、冒名或已迁移）', `${pkg.name}@${npm.version} → ${npmSlug ?? '未声明 repository'}`);

  const provenance = published && !!npm.dist?.attestations;
  if (published) add('V5', provenance ? 'ok' : 'unk', provenance ? 'npm 带 provenance 构建证明' : '无 provenance 构建证明', `dist.attestations ${provenance ? '存在' : '缺失'}`);

  const age = now - Date.parse(repo.pushedAt);
  const active = !repo.archived && age < 30 * DAY;
  if (repo.archived) add('V6', 'bad', '仓库已归档，不再维护', `isArchived = true`);
  else if (age < 90 * DAY) add('V6', 'ok', `近 ${Math.max(1, Math.round(age / DAY))} 天内有推送`, `pushedAt ${repo.pushedAt.slice(0, 10)}`);
  else add('V6', 'warn', '超过 90 天无推送', `pushedAt ${repo.pushedAt.slice(0, 10)}`);

  if (published && pkg.version && npm.version !== pkg.version) add('V6b', 'warn', '仓库版本与 npm 最新版不一致，安装以 npm 为准', `repo ${pkg.version} · npm ${npm.version}`);

  const owner = slug.split('/')[0];
  if (String(pkg.name).startsWith('@deepseek-ai/') && owner !== 'deepseek-ai') add('V9', 'bad', '使用官方作用域 @deepseek-ai 但仓库不属于 deepseek-ai', `${pkg.name} @ ${repo.repo}`);
  if (repo.fork) add('V10', 'unk', '这是一个 fork', 'isFork = true');

  const parts = [
    ['真插件（门槛）', 20],
    ['兼容声明', compat.status === 'ok' ? 30 : compat.status === 'incompatible' ? 5 : 10],
    ['安装脚本', hooks.length ? -15 : 15],
    ['来源链', chain === 'match' ? 15 : chain === 'mismatch' ? -20 : 0],
    ['provenance', provenance ? 10 : 0],
    ['活跃度', active ? 5 : repo.archived ? -10 : 0],
    ['star（对数）', Math.min(5, Math.round(Math.log10(1 + (repo.stars ?? 0)) * 2))],
  ];
  if (checks.some((c) => c.id === 'V9')) parts.push(['冒用官方作用域', -30]);
  const score = Math.max(0, Math.min(100, parts.reduce((a, [, n]) => a + n, 0)));

  const dshDeps = Object.keys({ ...(manifest.dependencies ?? {}), ...(manifest.peerDependencies ?? {}) }).filter((d) => d.startsWith('@deepseek-ai/'));
  const clientInject = Array.isArray(pkg.dsh.client?.inject) ? pkg.dsh.client.inject.filter((s) => typeof s === 'string') : [];
  const cats = classify({ name: pkg.name, description: pkg.description || repo.description, topics: repo.topics, keywords: Array.isArray(pkg.keywords) ? pkg.keywords : [], dshDeps, clientInject });

  return {
    name: String(pkg.name ?? repo.repo.split('/')[1]),
    repo: repo.repo,
    description: String(pkg.description || repo.description || ''),
    repoVersion: pkg.version ?? null,
    npmVersion: published ? npm.version : null,
    stars: repo.stars ?? 0,
    pushedAt: repo.pushedAt,
    createdAt: repo.createdAt,
    license: repo.license ?? null,
    topics: repo.topics ?? [],
    kinds,
    compat: compat.status,
    compatPeers: compat.peers,
    hooks,
    chain,
    provenance,
    archived: !!repo.archived,
    fork: !!repo.fork,
    clientInject,
    inserts: patchInserts(repo.patchText),
    depCount: Object.keys(manifest.dependencies ?? {}).length,
    cats,
    checks,
    score,
    scoreParts: parts,
    risky: checks.some((c) => c.st === 'bad'),
  };
}

/**
 * 同名包只留一条代表（来源链吻合者优先，其次得分、star），其余标 shadowOf，默认列表隐藏。
 * @param {object[]} records
 */
export function markShadows(records) {
  const groups = new Map();
  for (const r of records) {
    const list = groups.get(r.name) ?? [];
    list.push(r);
    groups.set(r.name, list);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => (b.chain === 'match') - (a.chain === 'match') || b.score - a.score || b.stars - a.stars || a.createdAt.localeCompare(b.createdAt));
    list.forEach((r, i) => { r.copies = list.length; r.shadowOf = i ? list[0].repo : null; });
  }
  return records;
}

/** 安装规格：发布了 npm 就锁精确版本；否则指向仓库 HEAD（提示用户自行锁 commit）。 */
export function installSpec(r) {
  return r.npmVersion ? `${r.name}@${r.npmVersion}` : `github:${r.repo}`;
}
