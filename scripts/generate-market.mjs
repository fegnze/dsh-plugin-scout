// Public, read-only generation. Repository/package text is data, never executed.
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index';
import { createGithub, crawlRepos, canonicalGithubSlug, pool } from '../src/core/crawl.mjs';
import { deriveRecords, emptyIndex, factOf, loadIndex, saveIndex } from '../src/core/store.mjs';
import { exportMarketIndex } from '../src/core/market.mjs';
import { compatibility } from '../src/core/verify.mjs';

async function registryJson(url, fetch) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(30000), redirect: 'error', headers: { accept: 'application/json', 'user-agent': 'dsh-plugin-scout-market' } });
      if (r.status === 404) return undefined;
      if (r.ok) return await r.json();
      if (r.status !== 429 && r.status < 500) throw new Error(`npm HTTP ${r.status}`);
      if (attempt === 3) throw new Error(`npm HTTP ${r.status}`);
    } catch (e) { if (attempt === 3) throw e; }
    await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
  }
}

export async function generateMarket({ token, cache, output, runtime = '0.2.1-rc.2', fetch = globalThis.fetch, bootstrap, discover = crawlRepos } = {}) {
  if (!token) throw new Error('GH_TOKEN is required for read-only GitHub discovery');
  const now = Date.now();
  const gh = createGithub({ token, fetch });
  const previous = bootstrap ? await loadIndex(bootstrap) : await loadIndex(cache);
  const index = emptyIndex();
  // Always traverse the full topic set: remove renamed/deleted entries instead of publishing old cache facts.
  const repos = await discover({ gh, now, known: key => previous.repos[key] });
  for (const [key, repo] of repos) index.repos[key] = factOf(repo);
  const names = [...new Set(Object.values(index.repos).filter(f => {
    const p = f.pkg;
    return f.plugin !== false && !f.archived && p?.dsh?.bundle
      && canonicalGithubSlug(p.repository) === f.repo.toLowerCase()
      && !['preinstall', 'install', 'postinstall', 'prepare'].some(h => p.scripts?.[h])
      && compatibility(p, runtime).status === 'ok';
  }).map(f => f.pkg.name))].sort();
  console.log(JSON.stringify({ phase: 'npm', repositoryCandidates: names.length }));
  const published = Object.create(null);
  let failures = 0;
  await pool(names, 2, async name => {
    if (!/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/.test(name) || name.length > 214) return;
    try {
      const manifest = await registryJson(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, fetch);
      if (!manifest || manifest.name !== name || typeof manifest.version !== 'string') return;
      index.npm[name] = { at: now, m: manifest };
    } catch { failures++; }
  });
  // Independently check canonical sources; never turn npm repository text directly into GitHub facts.
  const canonical = new Map();
  for (const [name, { m }] of Object.entries(index.npm)) {
    const key = canonicalGithubSlug(m.repository);
    if (key && index.repos[key]?.pkg?.name !== name) canonical.set(key, name);
  }
  await pool([...canonical], 3, async ([key, name]) => {
    try { const r = await gh.byRepo(key); if (r?.pkg?.name === name) index.repos[key] = factOf(r); } catch { failures++; }
  });
  index.crawledAt = index.fullAt = new Date(now).toISOString();
  // Full packuments are large: request release timestamps only for candidates that pass the core checks.
  const candidates = deriveRecords(index, { runtime, now }).filter(r => !r.shadowOf && r.chain === 'match' && !r.risky && r.provenance && r.compat === 'ok' && !r.hooks.length && !r.archived);
  await pool(candidates, 2, async r => {
    try {
      const packument = await registryJson(`https://registry.npmjs.org/${encodeURIComponent(r.name)}`, fetch);
      published[r.name] = packument?.time?.[r.npmVersion];
    } catch { failures++; }
  });
  const doc = exportMarketIndex(index, { runtime, now }, { published });
  parseMarketIndex(doc, 'https://fegnze.github.io/dsh-plugin-scout/index.json');
  if (!doc.plugins.length) throw new Error('Refusing to replace the public catalog with an empty result');
  if (failures > Math.max(5, names.length * 0.05)) throw new Error(`Refusing partial catalog: ${failures} upstream failures`);
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.tmp`;
  await writeFile(temporary, JSON.stringify(doc, null, 2) + '\n');
  await rename(temporary, output);
  await saveIndex(cache, index);
  console.log(JSON.stringify({ plugins: doc.plugins.length, repositories: repos.size, failures, output }));
  return doc;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = resolve(process.env.MARKET_OUTPUT || 'site/index.json');
  const cache = resolve(process.env.SCOUT_CACHE || '.cache/scout/index.json');
  await generateMarket({ token: process.env.GH_TOKEN, output, cache, bootstrap: process.env.SCOUT_BOOTSTRAP, runtime: process.env.DSH_TARGET || '0.2.1-rc.2' });
}
