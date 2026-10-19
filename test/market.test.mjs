import test from 'node:test';
import assert from 'node:assert/strict';
import semver from 'semver';
import { parseMarketIndex, marketInstallTarget } from '@deepseek-ai/dsh-plugin-market-index';
import { exportMarketIndex } from '../src/core/market.mjs';

const NOW = Date.parse('2026-10-19T00:00:00Z');
const env = { runtime: '0.2.0-rc.3', now: NOW };
const TIME = '2026-10-17T12:34:56.789Z';
function fixture(name = 'dsh-example', repo = 'alice/dsh-example') {
  const pkg = { name, version: '1.2.3', description: 'A memory plugin', dsh: { bundle: true }, repository: `https://github.com/${repo}`, peerDependencies: { '@deepseek-ai/dsh-app-boot': '>=0.2.0-rc.2 <0.3.0' }, scripts: {}, keywords: ['memory'], dist: { attestations: true } };
  return {
    version: 1, crawledAt: new Date(NOW).toISOString(),
    repos: { [repo]: { repo, pkg: structuredClone(pkg), createdAt: '2026-01-01T00:00:00Z', pushedAt: '2026-10-18T00:00:00Z', stars: 5, archived: false, fork: false, topics: ['dsh-plugin'] } },
    npm: { [name]: { at: NOW, m: pkg } },
  };
}
const run = (i, o = {}) => exportMarketIndex(i, env, { published: Object.fromEntries(Object.keys(i.npm).map((n) => [n, TIME])), ...o });
const firstFact = (i) => Object.values(i.repos)[0];
const manifest = (i) => Object.values(i.npm)[0].m;

// Execute the exact official format validator as well as our stricter public catalog contracts.
function assertFormat(i) {
  const parsed = parseMarketIndex(i, 'https://fegnze.github.io/dsh-plugin-scout/index.json');
  for (const p of parsed.plugins) assert.equal(marketInstallTarget(p.name, p.versions[0]).spec, `${p.name}@${p.versions[0].version}`);
  assert.equal(i.format, 1);
  assert.ok(typeof i.title === 'string' && i.title.trim());
  assert.equal(new Set(i.plugins.map((p) => p.name)).size, i.plugins.length);
  for (const p of i.plugins) {
    assert.match(p.name, /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/);
    const u = new URL(p.repository.url);
    assert.equal(u.protocol, 'https:');
    assert.equal(u.username + u.password + u.search + u.hash, '');
    assert.ok(Object.hasOwn(i.metadata.categories, p.metadata.category));
    for (const l of p.metadata.labels) assert.ok(Object.hasOwn(i.metadata.labels, l));
    assert.equal(new Set(p.metadata.labels).size, p.metadata.labels.length);
    for (const [k, v] of Object.entries(p.metadata.sortKeys)) {
      assert.ok(Object.hasOwn(i.metadata.sortKeys, k));
      assert.ok(Number.isFinite(v));
    }
    assert.equal(p.versions.length, 1);
    for (const v of p.versions) {
      assert.equal(semver.valid(v.version), v.version);
      assert.ok(Number.isInteger(v.publishTimestamp) && v.publishTimestamp >= 0 && v.publishTimestamp < 1e11);
      assert.deepEqual(v.source, { type: 'npm' });
      assert.ok(semver.validRange(v.engines.dsh));
      assert.ok(!v.engines.dsh.startsWith('workspace:'));
    }
  }
}

test('exports official structure, exact npm install version, metadata and real publication seconds without mutation', () => {
  const i = fixture();
  const before = structuredClone(i);
  const result = run(i);
  assertFormat(result);
  assert.equal(result.plugins.length, 1);
  const p = result.plugins[0];
  assert.equal(`${p.name}@${p.versions[0].version}`, 'dsh-example@1.2.3');
  assert.equal(p.versions[0].publishTimestamp, Math.floor(Date.parse(TIME) / 1000));
  assert.notEqual(p.versions[0].publishTimestamp, Date.parse(firstFact(i).pushedAt) / 1000);
  assert.equal(p.metadata.category, 'memory');
  assert.deepEqual(p.metadata.sortKeys, { score: 97, stars: 5 });
  assert.match(result.metadata.labels.provenance.title.en, /not cryptographically verified/);
  assert.deepEqual(i, before);
});

test('forks remain eligible, retain identity and are explicitly labelled', () => {
  const i = fixture('@alice/dsh-fork', 'alice/dsh-fork');
  firstFact(i).fork = true;
  const result = run(i);
  assertFormat(result);
  assert.equal(result.plugins[0].name, '@alice/dsh-fork');
  assert.equal(result.plugins[0].repository.url, 'https://github.com/alice/dsh-fork');
  assert.deepEqual(result.plugins[0].metadata.labels, ['fork', 'provenance']);
});

test('only canonical representative survives duplicate package names', () => {
  const i = fixture();
  i.repos['bob/copy'] = { ...structuredClone(firstFact(i)), repo: 'bob/copy', stars: 1000 };
  assert.equal(run(i).plugins.length, 1);
  assert.equal(run(i).plugins[0].repository.url, 'https://github.com/alice/dsh-example');
  i.repos.alias = structuredClone(firstFact(i));
  assert.equal(run(i).plugins.length, 1);
});

test('missing, malformed and out-of-bounds publication time exclude instead of guessing', () => {
  for (const time of [undefined, null, 1_700_000_000, '', 'yesterday', '2026-10-17', '1969-12-31T23:59:59Z', '9999-01-01T00:00:00Z']) {
    assert.equal(run(fixture(), { published: { 'dsh-example': time } }).plugins.length, 0, String(time));
  }
  assert.equal(run(fixture(), { published: {} }).plugins.length, 0);
  assert.equal(exportMarketIndex(fixture(), env).plugins.length, 0);
});

test('unsafe names, versions and repository lookalikes never become install targets', () => {
  for (const name of ['../evil', 'foo@latest', 'UPPER', '@a/b/c', '-x', 'foo?x', 'a'.repeat(215)]) assert.equal(run(fixture(name)).plugins.length, 0, name);
  for (const version of ['v1.2.3', '1.2', '1.2.3;echo', '01.2.3', '1.2.3-01']) {
    const i = fixture(); manifest(i).version = firstFact(i).pkg.version = version;
    assert.equal(run(i).plugins.length, 0, version);
  }
  for (const url of ['https://evilgithub.com/alice/dsh-example', 'https://github.com.evil/alice/dsh-example', 'https://user@github.com/alice/dsh-example', 'https://github.com/alice/dsh-example/extra', 'https://github.com/alice/../dsh-example', 'https://github.com/alice/dsh-example?evil=1', 'javascript:alert(1)']) {
    const i = fixture(); manifest(i).repository = url;
    assert.equal(run(i).plugins.length, 0, url);
  }
  const i = fixture('dsh-example', 'https://github.com/alice/dsh-example');
  assert.equal(run(i).plugins.length, 0);
});

test('conservative eligibility rejects incomplete, dangerous, unpublished and drifted facts', () => {
  const changes = [
    (i) => { firstFact(i).archived = true; },
    (i) => { manifest(i).scripts.postinstall = 'evil'; },
    (i) => { firstFact(i).pkg.scripts.prepare = 'evil'; },
    (i) => { firstFact(i).pkg.scripts.install = 'evil'; manifest(i).scripts.install = ''; },
    (i) => { manifest(i).dsh.bundle = 'not-a-bundle'; },
    (i) => { manifest(i).dist.attestations = false; },
    (i) => { manifest(i).dsh = { client: true }; },
    (i) => { firstFact(i).pkg.dsh = { client: true }; },
    (i) => { manifest(i).name = 'different'; },
    (i) => { firstFact(i).pkg.version = '1.2.4'; },
    (i) => { delete firstFact(i).pkg.version; },
    (i) => { manifest(i).peerDependencies = {}; },
    (i) => { manifest(i).peerDependencies['@deepseek-ai/dsh-app-boot'] = '^0.1.0'; },
    (i) => { i.npm['dsh-example'].m = null; },
    (i) => { delete i.npm['dsh-example']; },
    (i) => { delete firstFact(i).pushedAt; },
    (i) => { i.repos.bad = null; delete i.repos['alice/dsh-example']; },
  ];
  changes.forEach((change, n) => { const i = fixture(); change(i); assert.equal(run(i).plugins.length, 0, `case ${n}`); });
  const i = fixture('@deepseek-ai/fake');
  assert.equal(run(i).plugins.length, 0);
  assert.deepEqual(run({ repos: {}, npm: {} }).plugins, []);
});

test('stale/missing/future/invalid npm facts and absent freshness timestamps are excluded', () => {
  for (const at of [NOW - 86_400_001, NOW + 1, null, 'today', NaN]) {
    const i = fixture(); i.npm['dsh-example'].at = at;
    assert.equal(run(i).plugins.length, 0, String(at));
  }
  for (const flag of ['stale', 'missing']) {
    const i = fixture(); i.npm['dsh-example'][flag] = true;
    assert.equal(run(i).plugins.length, 0);
  }
  const i = fixture(); delete i.npm['dsh-example'].at;
  assert.equal(run(i).plugins.length, 0);
  assert.equal(exportMarketIndex(fixture(), { runtime: env.runtime }, { published: { 'dsh-example': TIME } }).plugins.length, 1);
});

test('real engines take precedence; never invent a runtime range for missing or workspace constraints', () => {
  const i = fixture();
  manifest(i).engines = { dsh: '>=0.2.0-rc.1 <0.3.0' };
  manifest(i).peerDependencies = { '@deepseek-ai/dsh-app-boot': '^0.1.0' };
  assert.equal(run(i).plugins[0].versions[0].engines.dsh, manifest(i).engines.dsh);
  for (const range of ['workspace:*', '', 'not a range', '^0.1.0']) {
    manifest(i).engines.dsh = range;
    assert.equal(run(i).plugins.length, 0, range);
  }
  delete manifest(i).engines;
  manifest(i).peerDependencies = { '@deepseek-ai/dsh-app-boot': 'workspace:^' };
  assert.equal(run(i).plugins.length, 0);
});

test('multiple real peer OR ranges are intersected without broadening compatibility', () => {
  const i = fixture();
  manifest(i).peerDependencies = {
    '@deepseek-ai/dsh-app-boot': '>=0.2.0-rc.1 <0.3.0 || >=1.0.0 <2.0.0',
    '@deepseek-ai/dsh-client': '>=0.2.0-rc.2 <0.2.1 || >=3.0.0',
  };
  const range = run(i).plugins[0].versions[0].engines.dsh;
  for (const version of ['0.2.0-rc.1', '0.2.0-rc.3', '0.2.0', '0.2.1', '1.5.0', '3.0.0']) {
    const expected = Object.values(manifest(i).peerDependencies).every((r) => semver.satisfies(version, r, { includePrerelease: true }));
    assert.equal(semver.satisfies(version, range, { includePrerelease: true }), expected, version);
  }
});

test('invalid caller runtime and freshness policies fail explicitly', () => {
  assert.throws(() => exportMarketIndex(fixture(), { runtime: 'unknown' }), /runtime/);
  assert.throws(() => run(fixture(), { npmMaxAgeMs: -1 }), /npmMaxAgeMs/);
});
