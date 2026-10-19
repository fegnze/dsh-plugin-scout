import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateMarket } from '../scripts/generate-market.mjs';

const name = 'dsh-fixture';
const pkg = { name, version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } }, repository: { url: 'https://github.com/alice/dsh-fixture' }, engines: { dsh: '>=0.2.0-rc.2 <0.3.0' }, peerDependencies: { '@deepseek-ai/dsh-app-boot': '>=0.2.0-rc.2 <0.3.0' }, dist: { attestations: { url: 'https://registry.npmjs.org/-/npm/v1/attestations/dsh-fixture@1.0.0' } } };
const fact = { repo: 'alice/dsh-fixture', pkg, createdAt: '2026-01-01T00:00:00Z', pushedAt: new Date().toISOString(), stars: 0, topics: ['dsh-plugin'] };
test('generator validates a fresh catalog, exports no private cache fields, and refuses empty replacement', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scout-market-'));
  const output = join(dir, 'site/index.json');
  const cache = join(dir, 'cache/index.json');
  const calls = [];
  const fetch = async (url, opts) => {
    calls.push([url, opts.redirect]);
    assert.ok(url.startsWith('https://registry.npmjs.org/'));
    return { ok: true, status: 200, json: async () => url.endsWith('/latest') ? pkg : { time: { '1.0.0': '2026-01-02T00:00:00Z' } } };
  };
  const discover = async () => new Map([[fact.repo, fact]]);
  const doc = await generateMarket({ token: 'fake-not-published', output, cache, fetch, discover });
  assert.equal(doc.plugins.length, 1);
  assert.equal(doc.plugins[0].versions[0].publishTimestamp, Date.parse('2026-01-02T00:00:00Z') / 1000);
  assert.ok(calls.every(([, redirect]) => redirect === 'error'));
  const first = await readFile(output, 'utf8');
  assert.ok(!first.includes('fake-not-published'));
  assert.ok(!first.includes('patchText'));
  await assert.rejects(generateMarket({ token: 'fake', output, cache, fetch, discover: async () => new Map() }), /empty result/);
  assert.equal(await readFile(output, 'utf8'), first, 'failed generation keeps deployed candidate unchanged');
});
