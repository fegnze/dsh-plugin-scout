// 索引：只存「事实」（仓库元数据 + 精简 package.json + npm latest 精简清单），判定每次加载时现算。
// 这样运行时版本变了、规则改了，不用重抓就能得到新结论。
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { evaluate, installSpec, markShadows, pluginKinds } from './verify.mjs';
import { CATEGORIES } from './classify.mjs';

export const INDEX_VERSION = 1;

export function emptyIndex() {
  return { version: INDEX_VERSION, crawledAt: null, fullAt: null, repos: {}, npm: {} };
}

export async function loadIndex(file) {
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    return data?.version === INDEX_VERSION && data.repos && data.npm ? data : emptyIndex();
  } catch (e) {
    if (e.code === 'ENOENT') return emptyIndex();
    throw e;
  }
}

export async function saveIndex(file, index) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(index));
  await rename(tmp, file);
}

/** 非插件仓库只留一个占位，免得每次增量都重复判断。 */
export function factOf(repo) {
  return pluginKinds(repo.pkg).length ? repo : { repo: repo.repo, pushedAt: repo.pushedAt, plugin: false };
}

/** 事实 → 判定后的记录集（含同名去重）。 */
export function deriveRecords(index, env) {
  const out = [];
  for (const fact of Object.values(index.repos)) {
    if (fact.plugin === false || !fact.pkg) continue;
    const npmEntry = index.npm[fact.pkg.name];
    const npm = npmEntry ? npmEntry.m : undefined;
    try {
      const r = evaluate(fact, npm, env);
      if (r) out.push(r);
    } catch { /* 单条坏数据不拖垮整个索引 */ }
  }
  return markShadows(out);
}

const SLIM = ['name', 'repo', 'description', 'repoVersion', 'npmVersion', 'stars', 'pushedAt', 'kinds', 'compat', 'hooks', 'chain', 'provenance', 'archived', 'score', 'scoreParts', 'risky', 'copies', 'shadowOf'];
export function slimRow(r) {
  const row = Object.fromEntries(SLIM.map((k) => [k, r[k]]));
  row.cats = r.cats.map((c) => c.id);
  row.spec = installSpec(r);
  return row;
}

/**
 * 服务端筛选、计数、排序、分页（完整索引上万条，不整包下发给界面）。
 * 分类计数与分类筛选正交：计数基于「除分类外的其它条件」。
 */
export function query(records, p) {
  const installed = new Set(p.installed ?? []);
  const q = (p.q ?? '').trim().toLowerCase();
  const compat = new Set(p.compat ?? []);
  const flags = new Set(p.flags ?? []);
  const base = records.filter((r) => {
    if (!flags.has('copies') && r.shadowOf) return false;
    if (q && !`${r.name} ${r.description} ${r.repo} ${r.cats.map((c) => CATEGORIES[c.id].label).join(' ')}`.toLowerCase().includes(q)) return false;
    if (compat.size && !compat.has(r.compat)) return false;
    if (flags.has('nohook') && r.hooks.length) return false;
    if (flags.has('prov') && !r.provenance) return false;
    if (flags.has('chain') && r.chain !== 'match') return false;
    if (flags.has('norisk') && r.risky) return false;
    if (flags.has('active') && Date.now() - Date.parse(r.pushedAt) > 30 * 86_400_000) return false;
    if (flags.has('client') && !r.kinds.includes('client')) return false;
    if (flags.has('hostonly') && r.kinds.includes('client')) return false;
    if (p.inst === 'hide' && installed.has(r.name)) return false;
    if (p.inst === 'only' && !installed.has(r.name)) return false;
    return true;
  });
  const cats = { all: base.length, other: 0 };
  for (const id of Object.keys(CATEGORIES)) cats[id] = 0;
  for (const r of base) {
    if (!r.cats.length) cats.other++;
    for (const c of r.cats) cats[c.id]++;
  }
  const cat = p.cat ?? 'all';
  let rows = cat === 'all' ? base : cat === 'other' ? base.filter((r) => !r.cats.length) : base.filter((r) => r.cats.some((c) => c.id === cat));
  const sort = p.sort ?? 'score';
  rows = rows.slice().sort(
    sort === 'stars' ? (a, b) => b.stars - a.stars
      : sort === 'recent' ? (a, b) => b.pushedAt.localeCompare(a.pushedAt)
        : sort === 'name' ? (a, b) => a.name.localeCompare(b.name)
          : (a, b) => b.score - a.score || b.stars - a.stars,
  );
  const offset = Math.max(0, p.offset | 0);
  const limit = Math.min(200, Math.max(1, p.limit | 0 || 50));
  return { total: rows.length, cats, rows: rows.slice(offset, offset + limit).map(slimRow) };
}

/** 全局计数（筛选栏旁的数字），基于去重后的代表记录。 */
export function facets(records) {
  const live = records.filter((r) => !r.shadowOf);
  const n = (f) => live.filter(f).length;
  return {
    plugins: live.length,
    copies: records.length - live.length,
    compat: { ok: n((r) => r.compat === 'ok'), incompatible: n((r) => r.compat === 'incompatible'), none: n((r) => r.compat === 'none') },
    flags: { nohook: n((r) => !r.hooks.length), prov: n((r) => r.provenance), chain: n((r) => r.chain === 'match'), norisk: n((r) => !r.risky), client: n((r) => r.kinds.includes('client')), hostonly: n((r) => !r.kinds.includes('client')) },
  };
}
