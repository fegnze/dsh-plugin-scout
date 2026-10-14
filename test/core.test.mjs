import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { classify, has } from '../src/core/classify.mjs';
import { compatibility, evaluate, githubSlug, installSpec, markShadows, patchInserts } from '../src/core/verify.mjs';
import { normalizeNode, slimManifest, windows, crawlRepos, createGithub } from '../src/core/crawl.mjs';
import { deriveRecords, emptyIndex, facets, factOf, query } from '../src/core/store.mjs';

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
    count: async () => 30,
    async *pages(q) { calls.push(q); yield page.data.search.nodes; },
  };
  const got = await crawlRepos({ gh, since: undefined, now: NOW });
  assert.equal(got.size, 30);
  assert.equal(calls.length, 1);
});
