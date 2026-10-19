// Pure projection of cached facts to official DSH market format 1. No I/O or installs.
import semver from 'semver';
import { canonicalGithubSlug } from './crawl.mjs';
import { CATEGORIES } from './classify.mjs';
import { deriveRecords } from './store.mjs';

const PACKAGE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u;
const NUM = '(?:0|[1-9]\\d*)';
const PRE = `(?:${NUM}|\\d*[a-zA-Z-][0-9a-zA-Z-]*)`;
const VERSION = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}(?:-${PRE}(?:\\.${PRE})*)?(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?$`, 'u');
const own = (o, k) => o != null && Object.hasOwn(o, k);
const object = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const text = (s) => typeof s === 'string' && s.trim() !== '';
const bundle = (m) => m?.dsh?.bundle === true || (object(m?.dsh?.bundle) && text(m.dsh.bundle.patch));
const hasHooks = (m) => ['preinstall', 'install', 'postinstall', 'prepare'].some((h) => text(m?.scripts?.[h]));

// Keep real constraints, never synthesize an assertion from the sampled runtime.
// engines.dsh takes precedence; otherwise distribute AND over peer OR branches.
function dshRange(manifest) {
  if (own(manifest?.engines, 'dsh')) {
    const r = manifest.engines.dsh;
    return text(r) && !r.startsWith('workspace:') && semver.validRange(r) !== null ? r : undefined;
  }
  const peers = Object.entries(manifest?.peerDependencies ?? {})
    .filter(([n]) => n === '@deepseek-ai/dsh' || n.startsWith('@deepseek-ai/dsh-'));
  if (!peers.length) return undefined;
  let branches = [''];
  for (const [, range] of peers) {
    if (!text(range) || range.startsWith('workspace:') || semver.validRange(range) === null) return undefined;
    const sets = new semver.Range(range).set;
    if (branches.length * sets.length > 128) return undefined;
    branches = branches.flatMap((a) => sets.map((s) => [a, ...s.map((c) => c.value)].filter(Boolean).join(' ')));
  }
  return branches.map((b) => b || '*').join(' || ');
}

function publishSeconds(value) {
  // Auxiliary packument time[exactVersion], not repository push time or a crawl time.
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return undefined;
  const seconds = Math.floor(Date.parse(value) / 1000);
  return Number.isInteger(seconds) && seconds >= 0 && seconds < 1e11 ? seconds : undefined;
}

/**
 * Export conservative npm-only format 1, without mutating input or using wall-clock time.
 * @param {object} index Internal fact index ({repos, npm: {[name]: {m, at?}}}).
 * @param {{runtime:string, now?:number}} env now is epoch milliseconds; otherwise crawledAt is used.
 * @param {{published?:Record<string,string>, title?:string, description?:string, npmMaxAgeMs?:number}} options
 * published[name] MUST be packument time[the cached manifest's exact version] as ISO text.
 * Missing release times or freshness timestamps exclude entries;
 * at must be valid and within npmMaxAgeMs (default one day) of the snapshot.
 * Provenance means advertised dist.attestations only, NOT cryptographic verification.
 */
export function exportMarketIndex(index, env, options = {}) {
  if (!semver.valid(env?.runtime)) throw new TypeError('env.runtime must be an exact SemVer version');
  const maxAge = options.npmMaxAgeMs ?? 86_400_000;
  if (!Number.isFinite(maxAge) || maxAge < 0) throw new TypeError('npmMaxAgeMs must be finite and non-negative');
  const now = env.now ?? Date.parse(index?.crawledAt);
  const metadata = {
    categories: Object.fromEntries([...Object.entries(CATEGORIES).map(([id, c]) => [id, { title: { en: id, zh: c.label } }]), ['other', { title: { en: 'Other', zh: '其他' } }]]),
    labels: {
      fork: { title: { en: 'Fork', zh: 'Fork 仓库' } },
      provenance: { title: { en: 'Provenance advertised (not cryptographically verified)', zh: '声明 provenance（未验证密码学证明）' } },
    },
    sortKeys: {
      score: { title: { en: 'Scout score', zh: 'Scout 评分' }, order: 'desc' },
      stars: { title: { en: 'GitHub stars', zh: 'GitHub 星标' }, order: 'desc' },
    },
  };
  const out = { format: 1, title: text(options.title) ? options.title : 'DSH Plugin Scout', metadata, plugins: [] };
  if (text(options.description)) out.description = options.description;
  if (!object(index?.repos) || !object(index?.npm)) return out;
  const safeIndex = { ...index, repos: Object.fromEntries(Object.entries(index.repos).filter(([, f]) =>
    object(f) && typeof f.repo === 'string' && object(f.pkg)
    && typeof f.createdAt === 'string' && Number.isFinite(Date.parse(f.createdAt))
    && typeof f.pushedAt === 'string' && Number.isFinite(Date.parse(f.pushedAt)))) };
  const records = deriveRecords(safeIndex, {
    runtime: env.runtime, now: Number.isFinite(now) ? now : 0,
    compat: (m) => {
      const range = dshRange(m);
      return { status: range && semver.satisfies(env.runtime, range, { includePrerelease: true }) ? 'ok' : 'incompatible', peers: {}, failed: {} };
    },
  });
  const facts = new Map(Object.values(index.repos).filter((f) => typeof f?.repo === 'string').map((f) => [f.repo, f]));
  const seen = new Set();
  for (const r of records) {
    try {
      if (r.shadowOf || r.archived || r.risky || r.hooks.length || r.chain !== 'match' || !r.provenance || r.compat !== 'ok') continue;
      if (!PACKAGE.test(r.name) || r.name.length > 214 || seen.has(r.name)) continue;
      const fact = facts.get(r.repo);
      const entry = own(index.npm, r.name) ? index.npm[r.name] : undefined;
      const m = entry?.m;
      if (!object(m) || m.name !== r.name || !VERSION.test(m.version) || !semver.valid(m.version)) continue;
      if (fact?.pkg?.version !== m.version || fact.pkg.name !== m.name) continue;
      if (entry.stale === true || entry.missing === true) continue;
      if (!Number.isFinite(entry.at) || !Number.isFinite(now) || entry.at > now || now - entry.at > maxAge) continue;
      if (!bundle(m) || !bundle(fact.pkg) || hasHooks(m) || hasHooks(fact.pkg)) continue;
      const slug = canonicalGithubSlug(r.repo);
      // Canonical identity must be a bare repository slug, not a URL accepted as a hint.
      if (!slug || r.repo.toLowerCase() !== slug || canonicalGithubSlug(m.repository) !== slug) continue;
      const publishTimestamp = publishSeconds(own(options.published, r.name) ? options.published[r.name] : undefined);
      if (publishTimestamp === undefined) continue;
      const range = dshRange(m);
      const plugin = {
        name: r.name,
        repository: { url: `https://github.com/${slug}` },
        metadata: {
          category: r.cats[0]?.id ?? 'other',
          keywords: [...new Set([...(Array.isArray(m.keywords) ? m.keywords : []), ...r.topics].filter((k) => typeof k === 'string'))],
          labels: [...(r.fork ? ['fork'] : []), 'provenance'],
          sortKeys: { score: Number.isFinite(r.score) ? r.score : 0, stars: Number.isFinite(r.stars) ? r.stars : 0 },
        },
        versions: [{ version: m.version, publishTimestamp, source: { type: 'npm' }, engines: { dsh: range } }],
      };
      if (text(r.description)) plugin.description = r.description;
      out.plugins.push(plugin);
      seen.add(r.name);
    } catch { /* An incomplete or malformed fact must not break the rest of the market. */ }
  }
  out.plugins.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return out;
}
