import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { classify, has } from '../src/core/classify.mjs';
import { compatibility, evaluate, githubSlug, installSpec, markShadows, patchInserts } from '../src/core/verify.mjs';
import { normalizeNode, slimManifest, windows, crawlRepos, createGithub, poolIter } from '../src/core/crawl.mjs';
import { createRecordSet, deriveRecords, emptyIndex, facets, factOf, query } from '../src/core/store.mjs';

const RT = '0.2.0-rc.2';
const NOW = Date.parse('2026-10-14T00:00:00Z');
const fixture = async (n) => JSON.parse(await readFile(new URL(`fixtures/${n}`, import.meta.url), 'utf8'));

test('classifier keeps the prototype accuracy on the 41 hand-labelled plugins', async () => {
  const gold = await fixture('gold.json');
  let top1 = 0;
  for (const x of gold) {
    const got = classify(x).map((c) => c.id);
    if ((got[0] ?? 'other') === x.gold) top1++;
  }
  assert.ok(top1 >= 35, `top-1 ${top1}/41`);
});

test('word-boundary matching: git ≠ digital, CJK by substring', () => {
  assert.equal(has('git', 'digital signage'), false);
  assert.equal(has('git', 'git flow'), true);
  assert.equal(has('记忆', '长期记忆插件'), true);
});

test('V2 mirrors the official peer rule', () => {
  const m = (peers) => ({ name: 'p', version: '1.0.0', peerDependencies: peers });
  assert.equal(compatibility({ name: 'p' }, RT).status, 'none');
  assert.equal(compatibility(m({ react: '^18' }), RT).status, 'none', 'non-DSH peers do not constrain');
  assert.equal(compatibility(m({ '@deepseek-ai/dsh-session': '>=0.1.7-rc.2' }), RT).status, 'ok', 'prerelease participates');
  assert.equal(compatibility(m({ '@deepseek-ai/dsh': '^0.1.5' }), RT).status, 'incompatible');
  assert.equal(compatibility(m({ '@deepseek-ai/dsh-agent': 'workspace:^' }), RT).status, 'ok');
  assert.equal(compatibility(m({ '@deepseek-ai/dsh-agent': '' }), RT).status, 'incompatible', 'empty range is incompatible');
  assert.equal(compatibility(m({ '@deepseek-ai/dsh-agent': 'not a range' }), RT).status, 'incompatible');
  assert.equal(compatibility(m({ '@deepseek-ai/cordis': '^1' }), RT).status, 'none', 'only dsh and dsh-* count');
});

test('repository slug normalisation', () => {
  assert.equal(githubSlug('git+https://github.com/A/B.git'), 'a/b');
  assert.equal(githubSlug({ url: 'git@github.com:a/b-c.git' }), 'a/b-c');
  assert.equal(githubSlug('github:a/b'), 'a/b');
  assert.equal(githubSlug('a/b'), 'a/b');
  assert.equal(githubSlug('https://gitlab.com/a/b'), undefined);
});

test('patch inserts are extracted as text, YAML tags are never evaluated', () => {
  assert.deepEqual(patchInserts("- insert:\n    - id: x\n      name: 'pkg-a'\n    - id: y\n      name: pkg-a/sub\n"), ['pkg-a', 'pkg-a/sub']);
  assert.deepEqual(patchInserts('- insert: !!js/function "x"'), []);
});

const repo = (pkg, extra = {}) => ({ repo: 'Own/Repo', description: '', stars: 9, pushedAt: '2026-10-10T00:00:00Z', createdAt: '2026-09-01T00:00:00Z', archived: false, fork: false, license: 'MIT', topics: ['dsh-plugin'], pkg: slimManifest(pkg), ...extra });

test('evaluate: verdicts and score are explainable and bounded', () => {
  const pkg = { name: 'good', version: '1.0.0', dsh: { bundle: {}, client: { inject: ['@deepseek-ai/dsh-client-ui-theme'] } }, peerDependencies: { '@deepseek-ai/dsh': '>=0.2.0-rc.1' }, repository: 'github:own/repo' };
  const npm = slimManifest({ ...pkg, dist: { attestations: { url: 'x' } } });
  const r = evaluate(repo(pkg), npm, { runtime: RT, now: NOW });
  assert.deepEqual(r.checks.map((c) => [c.id, c.st]), [['V1', 'ok'], ['V2', 'ok'], ['V3', 'ok'], ['V4', 'ok'], ['V5', 'ok'], ['V6', 'ok']]);
  assert.equal(r.score, 20 + 30 + 15 + 15 + 10 + 5 + 2);
  assert.equal(r.risky, false);
  assert.equal(r.cats[0].id, 'ui');
  assert.equal(installSpec(r), 'good@1.0.0');

  const bad = { name: '@deepseek-ai/dsh-evil', version: '1.0.0', dsh: { bundle: {} }, scripts: { postinstall: 'curl x | sh' }, repository: 'github:someone/else' };
  const b = evaluate(repo(bad), slimManifest(bad), { runtime: RT, now: NOW });
  const st = Object.fromEntries(b.checks.map((c) => [c.id, c.st]));
  assert.equal(st.V3, 'bad'); assert.equal(st.V4, 'bad'); assert.equal(st.V9, 'bad');
  assert.equal(b.risky, true);
  assert.equal(b.score, 0, 'clamped at 0');

  assert.equal(evaluate(repo({ name: 'lib' }), null, { runtime: RT, now: NOW }), undefined, 'non-plugins are dropped');
  const unpublished = evaluate(repo({ name: 'x', dsh: { bundle: true } }), null, { runtime: RT, now: NOW });
  assert.equal(unpublished.chain, 'unpublished');
  assert.equal(installSpec(unpublished), 'github:Own/Repo');
});

test('evaluate uses the npm manifest (what actually gets installed) for compat and scripts', () => {
  const repoPkg = { name: 'p', version: '2.0.0', dsh: { bundle: {} }, peerDependencies: { '@deepseek-ai/dsh': '>=0.2.0-rc.1' }, repository: 'github:own/repo' };
  const npm = slimManifest({ name: 'p', version: '1.0.0', dsh: { bundle: {} }, peerDependencies: { '@deepseek-ai/dsh': '^0.1.0' }, scripts: { install: 'node-gyp rebuild' }, repository: 'github:own/repo' });
  const r = evaluate(repo(repoPkg), npm, { runtime: RT, now: NOW });
  assert.equal(r.compat, 'incompatible');
  assert.deepEqual(r.hooks, ['install']);
  assert.ok(r.checks.some((c) => c.id === 'V6b'));
});

test('same-name copies collapse onto the chain-matching representative', () => {
  const mk = (repoName, chain, score, stars) => ({ name: 'dup', repo: repoName, chain, score, stars, createdAt: '2026-01-01' });
  const rs = markShadows([mk('a/x', 'mismatch', 90, 100), mk('b/x', 'match', 40, 1), mk('c/x', 'unpublished', 50, 5)]);
  assert.equal(rs.find((r) => r.repo === 'b/x').shadowOf, null);
  assert.equal(rs.find((r) => r.repo === 'a/x').shadowOf, 'b/x');
  assert.ok(rs.every((r) => r.copies === 3));
});

test('real GraphQL page normalises; plugin ratio matches the measured sample', async () => {
  const page = await fixture('graphql-page.json');
  const facts = page.data.search.nodes.map(normalizeNode).filter(Boolean);
  assert.equal(facts.length, 30);
  const index = { ...emptyIndex(), repos: Object.fromEntries(facts.map((f) => [f.repo.toLowerCase(), factOf(f)])) };
  const recs = deriveRecords(index, { runtime: RT, now: NOW });
  assert.ok(recs.length >= 24 && recs.length <= 30, `plugins ${recs.length}`);
  for (const r of recs) {
    assert.ok(r.score >= 0 && r.score <= 100);
    assert.ok(r.checks.every((c) => ['ok', 'warn', 'bad', 'unk'].includes(c.st)));
  }
  // 非插件只留占位
  assert.ok(Object.values(index.repos).some((f) => f.plugin === false));
});

test('query: category counts are orthogonal to the category filter; paging and sort', async () => {
  const page = await fixture('graphql-page.json');
  const facts = page.data.search.nodes.map(normalizeNode).filter(Boolean);
  const recs = deriveRecords({ ...emptyIndex(), repos: Object.fromEntries(facts.map((f) => [f.repo.toLowerCase(), factOf(f)])) }, { runtime: RT, now: NOW });
  const all = query(recs, {});
  const some = Object.entries(all.cats).find(([k, v]) => k !== 'all' && k !== 'other' && v > 0);
  const one = query(recs, { cat: some[0] });
  assert.equal(one.total, some[1]);
  assert.deepEqual(one.cats, all.cats, 'counts do not depend on the selected category');
  assert.ok(all.rows.every((r, i, a) => i === 0 || a[i - 1].score >= r.score));
  assert.equal(query(recs, { limit: 5 }).rows.length, Math.min(5, all.total));
  const f = facets(recs);
  assert.equal(f.compat.ok + f.compat.incompatible + f.compat.none, f.plugins);
  const inst = all.rows[0].name;
  assert.ok(query(recs, { inst: 'only', installed: [inst] }).rows.every((r) => r.name === inst));
  assert.ok(!query(recs, { inst: 'hide', installed: [inst] }).rows.some((r) => r.name === inst));
});

test('adaptive windows split until every window fits the 1000-result cap', async () => {
  const created = Array.from({ length: 5000 }, (_, i) => Date.parse('2026-08-01T00:00:00Z') + i * 60_000);
  const gh = {
    async count(q) {
      const [a, b] = q.match(/created:(\S+)\.\.(\S+)/).slice(1).map(Date.parse);
      return created.filter((t) => t >= a && t <= b).length;
    },
  };
  let sum = 0;
  for await (const w of windows(gh, 'dsh-plugin', 'created', Date.parse('2026-07-01T00:00:00Z'), Date.parse('2026-09-01T00:00:00Z'))) {
    assert.ok(w.count <= 900); sum += w.count;
  }
  assert.equal(sum, 5000, 'windows cover everything exactly once');
});

test('github pages: 502 steps the page size 50 -> 25 -> 10 and resumes from the same cursor', async () => {
  const seen = [];
  const reply = (status, body) => ({ status, headers: new Headers(), json: async () => body });
  const fetch = async (_u, init) => {
    const { variables: v } = JSON.parse(init.body);
    seen.push([v.after, v.n]);
    if (v.after === 'c1' && v.n > 10) return reply(502);
    const last = v.after === 'c1';
    return reply(200, { data: { search: { nodes: [{ id: v.after ?? 'first' }], pageInfo: { hasNextPage: !last, endCursor: 'c1' } } } });
  };
  const gh = createGithub({ token: 't', fetch });
  const got = [];
  for await (const nodes of gh.pages('q')) got.push(...nodes);
  assert.deepEqual(got.map((x) => x.id), ['first', 'c1']);
  assert.deepEqual(seen, [[null, 50], ['c1', 50], ['c1', 25], ['c1', 10]]);
  const dead = createGithub({ token: 't', fetch: async () => reply(502) });
  await assert.rejects(async () => { for await (const _ of dead.pages('q')); }, { code: 'upstream' });
  const bad = createGithub({ token: 't', fetch: async () => reply(401) });
  await assert.rejects(() => bad.count('q'), { code: 'auth' });
});

test('crawlRepos pages every window once and keys repos by owner/name', async () => {
  const page = await fixture('graphql-page.json');
  const calls = [];
  const gh = {
    count: async (q) => (q.includes('created:2008') ? 30 : 0), // 只有最老的播种窗有数据
    async *pages(q) { calls.push(q); yield page.data.search.nodes; },
  };
  const got = await crawlRepos({ gh, since: undefined, now: NOW });
  assert.equal(got.size, 30);
  assert.equal(calls.length, 1);
});

test('windows come out newest first, so a streaming crawl shows recent repos before old ones', async () => {
  const created = Array.from({ length: 5000 }, (_, i) => Date.parse('2026-08-01T00:00:00Z') + i * 60_000);
  const gh = { async count(q) { const [a, b] = q.match(/created:(\S+)\.\.(\S+)/).slice(1).map(Date.parse); return created.filter((t) => t >= a && t <= b).length; } };
  const starts = [];
  for await (const w of windows(gh, 'dsh-plugin', 'created', Date.parse('2026-07-01T00:00:00Z'), Date.parse('2026-09-01T00:00:00Z'))) starts.push(Date.parse(w.q.match(/created:(\S+)\.\./)[1]));
  assert.ok(starts.length > 1);
  assert.deepEqual(starts, [...starts].sort((a, b) => b - a));
});

test('crawlRepos streams: the newest window is paged while an older window is still being counted', async () => {
  const NODES = (tag) => Array.from({ length: 3 }, (_, i) => ({ nameWithOwner: `${tag}/r${i}`, pushedAt: '2026-10-01T00:00:00Z' }));
  let release;
  const gate = new Promise((r) => { release = r; });
  const gh = {
    async count(q) {
      if (q.includes('2026-10-10T00:00:00Z..2026-10-14T00:00:00Z')) return 10; // 总数
      if (q.includes('2026-10-10T00:00:00Z..')) { await gate; return 5; } // 最老的播种窗：计数卡住
      if (q.endsWith('..2026-10-14T00:00:00Z')) return 5; // 最新的播种窗（近 6 小时）
      return 0;
    },
    async *pages(q) { yield NODES(q.includes('2026-10-10T00:00:00Z') ? 'old' : 'new'); },
  };
  const batches = [];
  const done = crawlRepos({ gh, since: Date.parse('2026-10-10T00:00:00Z'), now: Date.parse('2026-10-14T00:00:00Z'), onBatch: (b) => batches.push(b) });
  for (let i = 0; i < 100 && !batches.length; i++) await new Promise((r) => setTimeout(r, 2));
  assert.equal(batches.length, 1, 'first batch arrived while the old window was still blocked');
  assert.ok(batches[0][0].repo.startsWith('new/'), 'newest window first');
  release();
  const all = await done;
  assert.equal(all.size, 6);
  assert.deepEqual(batches.map((b) => b[0].repo.split('/')[0]), ['new', 'old']);
});

test('poolIter: bounded concurrency, consumes everything once, propagates errors', async () => {
  async function* gen(n) { for (let i = 0; i < n; i++) { await new Promise((r) => setTimeout(r, 1)); yield i; } }
  let live = 0; let peak = 0; const got = [];
  await poolIter(gen(20), 3, async (x) => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 3)); got.push(x); live--; });
  assert.equal(peak, 3);
  assert.deepEqual(got.sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i));
  await assert.rejects(() => poolIter(gen(5), 2, async (x) => { if (x === 2) throw new Error('boom'); }), /boom/);
});

test('createRecordSet: upsert/remove only touch one key; snapshot equals a full derive', () => {
  const env = { runtime: '0.2.0-rc.2', now: Date.parse('2026-10-14T00:00:00Z') };
  const mk = (name, stars) => factOf({ repo: `o/${name}`, description: 'memory', stars, pushedAt: '2026-10-01T00:00:00Z', createdAt: '2026-09-01T00:00:00Z', archived: false, fork: false, license: 'MIT', topics: [], pkg: { name, version: '1.0.0', dsh: { bundle: true } } });
  const index = { ...emptyIndex(), repos: { 'o/a': mk('a', 1), 'o/b': mk('b', 2) } };
  const set = createRecordSet(() => env);
  set.reset(index);
  assert.deepEqual(set.snapshot().map((r) => r.repo).sort(), deriveRecords(index, env).map((r) => r.repo).sort());
  set.upsert('o/c', mk('c', 3), {});
  set.remove('o/a');
  set.upsert('o/b', { ...mk('b', 2), plugin: false }, {});
  assert.deepEqual(set.snapshot().map((r) => r.repo), ['o/c']);
});

test('seedSpans: geometric spans newest-last, contiguous, inside [from, to]', async () => {
  const { seedSpans } = await import('../src/core/crawl.mjs');
  const to = Date.parse('2026-10-14T00:00:00Z');
  const spans = seedSpans(Date.parse('2008-01-01T00:00:00Z'), to);
  assert.equal(spans.length, 7);
  assert.equal(spans.at(-1)[1], to);
  assert.equal(spans.at(-1)[1] - spans.at(-1)[0], 6 * 3_600_000 - 1000);
  for (let i = 1; i < spans.length; i++) assert.equal(spans[i][0], spans[i - 1][1] + 1000);
  assert.equal(seedSpans(to - 3_600_000, to).length, 1, 'short ranges are not split');
});

test('crawlRepos with known facts: unchanged repos skip blob fetch, changed ones fetched by id', async () => {
  const light = (name, pushedAt) => ({ id: `id-${name}`, nameWithOwner: `o/${name}`, pushedAt, stargazerCount: 7 });
  const byIdsCalls = [];
  const gh = {
    count: async (q) => (q.includes('created:2008') ? 3 : 0),
    async *pages(q, o) { assert.equal(o.light, true); yield [light('same', '2026-10-01T00:00:00Z'), light('moved', '2026-10-13T00:00:00Z'), light('new', '2026-10-13T00:00:00Z')]; },
    async byIds(ids) { byIdsCalls.push(ids); return ids.map((id) => ({ nameWithOwner: `o/${id.slice(3)}`, pushedAt: '2026-10-13T00:00:00Z' })); },
  };
  const knownFacts = { 'o/same': { repo: 'o/same', pushedAt: '2026-10-01T00:00:00Z', stars: 1, pkg: { name: 'same' } }, 'o/moved': { repo: 'o/moved', pushedAt: '2026-09-01T00:00:00Z', pkg: { name: 'moved' } } };
  const progress = [];
  const got = await crawlRepos({ gh, now: NOW, known: (k) => knownFacts[k], onProgress: (p) => progress.push(p) });
  assert.deepEqual(byIdsCalls, [['id-moved', 'id-new']]);
  assert.equal(got.get('o/same').stars, 7, 'metadata refreshed from the light page');
  assert.deepEqual(got.get('o/same').pkg, { name: 'same' }, 'facts kept without refetching package.json');
  assert.deepEqual([progress.at(-1).changed, progress.at(-1).unchanged], [2, 1]);
});
