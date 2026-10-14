// Loads the BUILT client (lib/client.js) the way DSH does (__ModuleLoader__), with a fake same-origin API.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

const require = createRequire(import.meta.url);
const browser = new Window({ url: 'http://localhost/' });
const copied = [];
Object.assign(globalThis, { window: browser, document: browser.document, HTMLElement: browser.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (t) => { copied.push(t); } } }, configurable: true });
const text = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
let client;
browser.__ModuleLoader__ = { load: ({ factory }) => { client = factory(require); } };
vm.runInThisContext(text);
after(async () => { await browser.happyDOM.abort(); await browser.happyDOM.close(); });

const ID = 'dsh-plugin-scout';
const row = (name, repo, score, extra = {}) => ({ name, repo, score, risky: false, description: `${name} desc`, stars: 3, pushedAt: '2026-10-01T00:00:00Z', npmVersion: '1.0.0', compat: 'ok', chain: 'match', hooks: [], provenance: false, kinds: ['bundle'], cats: ['memory'], scoreParts: [['gate', 20]], spec: `${name}@1.0.0`, copies: 0, ...extra });
// Shape matches verify.mjs add(id, st, text, ev).
const CHECKS = [{ id: 'V1', st: 'ok', text: '真插件：dsh.bundle', ev: 'dsh: { bundle }' }, { id: 'V3', st: 'bad', text: '安装钩子：postinstall', ev: 'node x.js' }];
const ROWS = [row('alpha', 'o/alpha', 92), row('evil', 'x/evil', 8, { risky: true, hooks: ['postinstall'], spec: 'github:x/evil' })];

const requests = [];
globalThis.fetch = async (url, init = {}) => {
  requests.push({ url, init });
  const ok = (value) => ({ status: 200, json: async () => ({ ok: true, value }) });
  assert.equal(init.headers['x-dsh-plugin-scout'], '1', 'intent header on every call');
  assert.equal(init.credentials, 'same-origin');
  const u = new URL(url, 'http://localhost');
  if (u.pathname === '/dsh-plugin-scout/api/status') return ok({ running: false, crawledAt: '2026-10-13T00:00:00Z', fullAt: '2026-10-13T00:00:00Z', runtime: '0.2.0-rc.2', runtimeSource: 'test', repos: 19000, error: null, categories: { memory: '记忆', ui: '界面' }, facets: { compat: { ok: 2 }, flags: {}, copies: 0 } });
  if (u.pathname === '/dsh-plugin-scout/api/list') return ok({ total: ROWS.length, cats: { all: 2, memory: 2 }, rows: ROWS });
  if (u.pathname === '/dsh-plugin-scout/api/detail') {
    const r = ROWS.find((x) => x.repo === u.searchParams.get('key'));
    return ok({ ...r, checks: CHECKS, cats: [{ id: 'memory', score: 5, evidence: ['memory'] }], inserts: [], clientInject: [], compatPeers: {}, depCount: 1, copiesList: [] });
  }
  if (u.pathname === '/dsh-plugin-scout/api/badges') {
    const { names } = JSON.parse(init.body);
    return ok(Object.fromEntries(names.filter((n) => n === 'alpha').map((n) => [n, { repo: 'o/alpha', score: 92, risky: false, npmVersion: '1.0.0', checks: CHECKS }])));
  }
  return { status: 404, json: async () => ({ ok: false, error: { code: 'not-found', message: u.pathname } }) };
};

function mockContext(services = {}) {
  const registrations = [], effects = [];
  return {
    registrations,
    effect(fn) { const d = fn(); effects.push(d); return d; },
    locale: { register: () => () => {}, bind: () => (k) => k },
    slots: {
      inject(name, fn) { const d = fn(); effects.push(d); return d; },
      register(options, component) { const e = { options, component, active: true }; registrations.push(e); return () => { e.active = false; }; },
    },
    get: (name) => { if (!(name in services)) throw new Error(`no service ${name}`); return services[name]; },
    on: () => () => {},
    dispose() { for (const d of effects.reverse()) typeof d === 'function' && d(); },
  };
}

async function render(element) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  return { container, async close() { await act(async () => root.unmount()); container.remove(); } };
}
const flush = (ms = 60) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const find = (c, sel, re) => [...c.querySelectorAll(sel)].find((el) => re.test(el.textContent));

test('registers exactly the public seams: page, sidebar entry, official badge + section', () => {
  const ctx = mockContext();
  client.apply(ctx);
  const names = ctx.registrations.map((r) => r.options.name).sort();
  assert.deepEqual(names, ['main', 'plugins.detail.badge', 'plugins.detail.section', 'sidebar.panellist']);
  assert.equal(ctx.registrations.find((r) => r.options.name === 'main').options.key, ID);
  assert.equal(ctx.registrations.find((r) => r.options.name === 'sidebar.panellist').options.id, ID);
  assert.deepEqual([...client.inject], ['slots', 'locale']);
  ctx.dispose();
  assert.equal(ctx.registrations.some((r) => r.active), false);
});

test('stylesheet is owned before insertion and removed on dispose; no host bg aliases or dialog role', () => {
  const insert = document.head.appendChild.bind(document.head);
  let checked = false;
  document.head.appendChild = (node) => {
    if (node.dataset?.scout === ID) { assert.equal(node.dataset.plugin, ID); assert.equal(node.dataset.pluginCss, `${ID}/style`); checked = true; }
    return insert(node);
  };
  const ctx = mockContext();
  try { client.apply(ctx); } finally { document.head.appendChild = insert; }
  assert.ok(checked);
  const css = document.querySelector('style[data-scout]').textContent;
  assert.match(css, /--dsw-alias-/);
  assert.match(css, /body\[data-ds-dark-theme\]/);
  assert.doesNotMatch(css, /`/, 'no backticks inside the CSS payload');
  for (const bad of ['card', 'bubble', 'pill', 'banner', 'panel']) assert.doesNotMatch(css, new RegExp(`\\.scx-[\\w-]*${bad}`), `class name avoids host skin substring "${bad}"`);
  ctx.dispose();
  assert.equal(document.querySelector('style[data-scout]'), null);
});

test('official detail slots: render for an indexed bundle, null for unknown/item subjects', async () => {
  const ctx = mockContext({ layout: { selectPanel() {} } });
  client.apply(ctx);
  const Badge = ctx.registrations.find((r) => r.options.name === 'plugins.detail.badge').component;
  const Section = ctx.registrations.find((r) => r.options.name === 'plugins.detail.section').component;
  const v = await render(React.createElement('div', null,
    React.createElement(Badge, { subject: { kind: 'bundle', pkg: { name: 'alpha' } } }),
    React.createElement(Section, { subject: { kind: 'bundle', pkg: { name: 'alpha' } } }),
    React.createElement('i', { id: 'sep' }),
    React.createElement(Badge, { subject: { kind: 'bundle', pkg: { name: 'ghost' } } }),
    React.createElement(Section, { subject: { kind: 'item', id: 'x' } })));
  await flush();
  assert.match(v.container.querySelector('.scx-badge').textContent, /badge 92/);
  assert.equal(v.container.querySelectorAll('[data-scout-section]').length, 1);
  assert.match(v.container.querySelector('[data-scout-section]').textContent, /安装钩子/);
  assert.equal(v.container.querySelector('#sep').nextSibling, null, 'unknown bundle and item subjects render nothing');
  const badgeCalls = requests.filter((r) => r.url.endsWith('/api/badges'));
  assert.equal(badgeCalls.length, 1, 'lookups batched into one request');
  await v.close();
  ctx.dispose();
});

test('page → drawer: lists, inspects through official pluginManager, risky copy needs two clicks, jumps to official page', async () => {
  const inspected = [];
  const opened = [];
  const pm = {
    listBundles: async () => ({ ok: true, value: [{ name: 'alpha', installed: true }] }),
    inspect: async (spec) => { inspected.push(spec); return { ok: true, value: { status: 'accepted', kind: 'registry', name: 'alpha', version: '1.0.0', bundle: true, registry: 'https://registry.npmjs.org/' } }; },
    install: () => assert.fail('scout must never install'), removeBundle: () => assert.fail('never remove'), setBundleEnabled: () => assert.fail('never toggle'),
  };
  const ctx = mockContext({ remote: { $on: () => () => {} }, 'remote.pluginManager': pm, pluginNavigation: { openBundle: (n) => opened.push(['bundle', n]) }, layout: { selectPanel: (p) => opened.push(['panel', p]) } });
  client.apply(ctx);
  const Page = ctx.registrations.find((r) => r.options.name === 'main').component;
  const v = await render(React.createElement(Page));
  await flush();
  const items = v.container.querySelectorAll('.scx-item');
  assert.equal(items.length, 2);
  assert.match(items[0].textContent, /alpha/);
  assert.match(items[0].textContent, /已安装/, 'installed state comes from official listBundles');

  await act(async () => items[0].click());
  await flush();
  const drawer = document.querySelector('[data-scout-drawer]');
  assert.ok(drawer);
  assert.equal(drawer.getAttribute('role'), null, 'drawer avoids role=dialog (host skin repaints it)');
  await act(async () => find(drawer, 'button', /预检/).click());
  await flush();
  assert.deepEqual(inspected, ['alpha@1.0.0']);
  assert.match(drawer.textContent, /可以添加：解析到 alpha@1\.0\.0/);
  await act(async () => find(drawer, 'button', /复制锁定规格/).click());
  await flush(10);
  assert.deepEqual(copied, ['alpha@1.0.0']);
  await act(async () => find(drawer, 'button', /在插件页打开/).click());
  assert.deepEqual(opened, [['bundle', 'alpha']]);
  await act(async () => drawer.querySelector('[aria-label="关闭"]').click());

  await act(async () => v.container.querySelectorAll('.scx-item')[1].click());
  await flush();
  const d2 = document.querySelector('[data-scout-drawer]');
  copied.length = 0;
  await act(async () => find(d2, 'button', /了解风险后复制/).click());
  await flush(10);
  assert.deepEqual(copied, [], 'first click only arms');
  await act(async () => find(d2, 'button', /再点一次确认复制/).click());
  await flush(10);
  assert.deepEqual(copied, ['github:x/evil']);
  await act(async () => find(d2, 'button', /去插件页添加/).click());
  assert.deepEqual(opened.at(-1), ['panel', 'plugins'], 'not installed → official Plugins page, where the user pastes the spec');

  await v.close();
  ctx.dispose();
});

// 回归：真实 cordis 的 ctx 代理比 mockContext 严格——读未 inject 的属性（含嵌套服务 remote.pluginManager）会抛错，
// 一旦在 apply 或其 effect 里抛出，fiber 进 FAILED，DSH web boot 报「dsh-plugin-scout: failed」，桌面端起不来。
// 这里用 App 同版本的 cordis（4.0.4），按官方结构把 pluginManager 挂成独立服务 remote.pluginManager。
test('activates under real cordis with and without the official remote.pluginManager service', async () => {
  const { Context, Service } = await import('@deepseek-ai/cordis');
  const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
  for (const withRemote of [true, false]) {
    const root = new Context();
    const seen = [];
    let listed = 0;
    root.plugin(class extends Service {
      constructor(ctx) { super(ctx, 'slots'); }
      inject(_key, cb) { return cb(); }
      register(options) { seen.push(options.name); return () => {}; }
    });
    root.plugin(class extends Service {
      constructor(ctx) { super(ctx, 'locale'); }
      register() { return () => {}; }
      bind() { return (k) => k; }
    });
    if (withRemote) {
      root.plugin(class extends Service { constructor(ctx) { super(ctx, 'remote'); } $on() { return () => {}; } });
      await tick();
      root.plugin(class extends Service {
        constructor(ctx) { super(ctx, 'remote.pluginManager'); }
        async listBundles() { listed++; return { ok: true, value: [] }; }
        async inspect() { return { ok: true, value: {} }; }
      });
    }
    await tick();
    const fiber = root.plugin({ name: ID, inject: client.inject, apply: client.apply });
    await fiber;
    await tick();
    assert.equal(fiber.state, 2, `fiber ACTIVE (withRemote=${withRemote}), not FAILED`);
    assert.deepEqual(seen.sort(), ['main', 'plugins.detail.badge', 'plugins.detail.section', 'sidebar.panellist']);
    await fiber.dispose();
    void listed;
  }
  document.querySelectorAll('style[data-scout]').forEach((s) => s.remove());
});

test('without the official pluginManager the page still works and inspect is hidden', async () => {
  const ctx = mockContext();
  client.apply(ctx);
  const Page = ctx.registrations.find((r) => r.options.name === 'main').component;
  const v = await render(React.createElement(Page));
  await flush();
  await act(async () => v.container.querySelector('.scx-item').click());
  await flush();
  const drawer = document.querySelector('[data-scout-drawer]');
  assert.equal(find(drawer, 'button', /^预检/), undefined);
  await v.close();
  ctx.dispose();
});
