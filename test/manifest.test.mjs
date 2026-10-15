// 发布清单对齐 DSH 官方插件约定（docs/user/develop/basic/publish、docs/cookbook/adding-a-package §5、
// @deepseek-ai/dsh-package-manifest 类型）。只断言官方文档写明的规则。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import semver from 'semver';

const root = new URL('../', import.meta.url);
const read = async (p) => readFile(new URL(p, root), 'utf8');
const pkg = JSON.parse(await read('package.json'));

test('bundle manifest: name/version, dsh.bundle.patch exists, manifestVersion 1, no unknown dsh keys', async () => {
  assert.ok(pkg.name && semver.valid(pkg.version), 'name and a valid version are required');
  assert.equal(pkg.private, undefined, 'published bundle must not be private');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.dsh.manifestVersion, 1);
  assert.deepEqual(Object.keys(pkg.dsh).sort(), ['bundle', 'client', 'manifestVersion'], 'only public author fields under dsh');
  assert.equal(pkg.dsh.client.platform, 'web');
  const patch = await read(pkg.dsh.bundle.patch);
  assert.match(patch, /name:\s*'dsh-plugin-scout'/, 'patch rows reference the package by name, not a relative path');
  assert.ok(pkg.files.includes('cordis.patch.yml'));
});

test('display metadata: locale/en.json is the discovery entry, zh mirrors its fields, both exported and shipped', async () => {
  const en = JSON.parse(await read('locale/en.json'));
  const zh = JSON.parse(await read('locale/zh.json'));
  for (const m of [en.meta, zh.meta]) {
    for (const k of ['title', 'description']) assert.ok(typeof m[k] === 'string' && m[k].trim(), `meta.${k} non-empty`);
  }
  assert.deepEqual(Object.keys(zh.meta).sort(), Object.keys(en.meta).sort());
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json');
  assert.equal(pkg.exports['./package.json'], './package.json');
  assert.ok(pkg.files.includes('locale/*.json'));
});

test('icon: relative SVG inside the package, under 256 KiB, self-contained, shipped', async () => {
  assert.match(pkg.icon, /^\.\/[^/].*\.svg$/);
  const svg = await read(pkg.icon);
  assert.ok((await stat(new URL(pkg.icon, root))).size <= 256 * 1024);
  assert.doesNotMatch(svg, /<script|href=["'](?!#)|url\((?!#)/i, 'no scripts or external references');
  assert.ok(pkg.files.includes(pkg.icon.slice(2)));
});

test('peers: every DSH peer is a valid range covering the target runtime and mirrored or optional; cordis mirrored with the same range', () => {
  const runtime = '0.2.0-rc.2';
  for (const [name, range] of Object.entries(pkg.peerDependencies)) {
    if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue;
    assert.ok(semver.validRange(range), `${name}: valid range`);
    assert.ok(semver.satisfies(runtime, range, { includePrerelease: true }), `${name} covers ${runtime}`);
    assert.ok(pkg.peerDependenciesMeta?.[name]?.optional || pkg.devDependencies?.[name], `${name}: optional or mirrored`);
  }
  assert.equal(pkg.devDependencies['@deepseek-ai/cordis'], pkg.peerDependencies['@deepseek-ai/cordis']);
  assert.ok(semver.satisfies(runtime, pkg.engines.dsh, { includePrerelease: true }), 'engines.dsh covers the target runtime');
});

test('docs: English README.md and docs/zh.md link to each other, both shipped', async () => {
  const en = await read('README.md');
  const zh = await read('docs/zh.md');
  assert.match(en, /\[中文\]\(docs\/zh\.md\)/);
  assert.match(zh, /\[English\]\(\.\.\/README\.md\)/);
  assert.doesNotMatch(en.replace(/`[^`]*`|\*\*[^*]*\*\*|\[中文\]/g, ''), /[\u4e00-\u9fff]{4,}/, 'README.md stays English (UI labels only in code or bold)');
  assert.equal((en.match(/^## /gm) || []).length, (zh.match(/^## /gm) || []).length, 'same section count');
  assert.ok(pkg.files.includes('docs/zh.md'));
});

test('distribution: prebuilt lib only, no install hooks, repository points at the GitHub repo', () => {
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) assert.equal(pkg.scripts[hook], undefined, `no ${hook}: users never approve a build`);
  assert.deepEqual(pkg.files.filter((f) => f.startsWith('lib')), ['lib/host.js', 'lib/client.js']);
  assert.ok(pkg.keywords.includes('dsh-plugin'));
  assert.match(pkg.repository.url, /^git\+https:\/\/github\.com\/[^/]+\/dsh-plugin-scout\.git$/);
  assert.equal(pkg.publishConfig.provenance, true);
});
