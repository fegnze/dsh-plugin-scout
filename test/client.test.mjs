// Loads the BUILT client (lib/client.js) the way DSH does (__ModuleLoader__), with a fake same-origin API.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';

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
  if (u.pathname === '/dsh-plugin-scout/api/auth') return ok({ configured: true, source: 'test', writable: true, stored: false, storage: 'credentials' });
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
    locale: { register: () => () => {}, bind: () => (k) => k === 'panel' ? 'Scout' : k },
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

test('GitHub setup opens on first use, saves transient password, checks and clears with fallback', async () => {
  const baseFetch = globalThis.fetch;
  let saved = false; const actions = [];
  globalThis.fetch = async (url, init = {}) => {
    if (!String(url).endsWith('/api/auth')) return baseFetch(url, init);
    const body = init.body ? JSON.parse(init.body) : {};
    if (body.action) actions.push(body);
    if (body.action === 'save') saved = true;
    if (body.action === 'clear') saved = false;
    return { status: 200, json: async () => ({ ok: true, value: { configured: saved || body.action === 'clear', source: saved ? 'DSH credentials' : body.action === 'clear' ? 'GITHUB_TOKEN' : 'none', stored: saved, writable: true, storage: 'credentials', ...(body.action === 'check' ? { check: { ok: true, message: 'GitHub 连接成功' } } : {}) } }) };
  };
  const ctx = mockContext(); client.apply(ctx); let v;
  try {
    const Page = ctx.registrations.find((r) => r.options.name === 'plugins.tab').component;
    v = await render(React.createElement(Page)); await flush();
    assert.ok(v.container.querySelector('.scx-auth')); assert.match(v.container.textContent, /明文文件/); assert.match(v.container.textContent, /gh auth login --hostname github.com/);
    const password = v.container.querySelector('input[type="password"]');
    await act(async () => { Simulate.change(password, { target: { value: 'ghp_CLIENT_TEST_1234567890' } }); });
    await act(async () => find(v.container, 'button', /^保存 Token$/).click()); await flush();
    assert.equal(password.value, ''); assert.equal(actions[0].token, 'ghp_CLIENT_TEST_1234567890');
    await act(async () => find(v.container, 'button', /^连接检测$/).click()); await flush();
    assert.ok(find(v.container, 'button', /^刷新索引$/));
    await act(async () => find(v.container, 'button', /^清除$/).click()); await flush();
    assert.match(v.container.textContent, /GITHUB_TOKEN/); assert.deepEqual(actions.map((x) => x.action), ['save', 'check', 'clear']);
    assert.equal(browser.localStorage.length, 0);
  } finally { if (v) await v.close(); ctx.dispose(); globalThis.fetch = baseFetch; }
});

test('registers exactly the public seams: Scout tab, official badge + section, no sidebar or main panel', () => {
  const ctx = mockContext();
  client.apply(ctx);
  const names = ctx.registrations.map((r) => r.options.name).sort();
  assert.deepEqual(names, ['plugins.detail.badge', 'plugins.detail.section', 'plugins.tab']);
  const tab = ctx.registrations.find((r) => r.options.name === 'plugins.tab');
  assert.equal(tab.options.id, ID);
  assert.equal(tab.options.order, 40);
  assert.equal(typeof tab.options.label === 'function' ? tab.options.label() : tab.options.label, 'Scout');
  assert.deepEqual([...client.inject], ['slots', 'locale']);
  ctx.dispose();
  assert.equal(ctx.registrations.some((r) => r.active), false);
});

test('stylesheet is owned, theme-aligned and responsive; removed on dispose', () => {
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
  assert.match(css, /--scx-tile:\s*var\(--dsw-alias-bg-layer-1\)/);
  assert.match(css, /input::placeholder\s*\{[^}]*var\(--scx-ink4\)/);
  assert.match(css, /\.scx-search:focus-within/);
  assert.match(css, /@media\s*\(max-width:\s*720px\)/);
  assert.doesNotMatch(css, /max-width:\s*420px/, 'search expands with the official page toolbar');
  assert.match(css, /\.scx-results\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(css, /\.scx-results\s*\{[^}]*overscroll-behavior-y:\s*contain/);
  assert.match(css, /\.scx-filters\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(css, /\.scx-list\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*hidden/);
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
  assert.doesNotMatch(v.container.querySelector('[data-scout-section]').textContent, /在发现页查看/);
  assert.equal(v.container.querySelector('[data-scout-section] button, [data-scout-section] a'), null, 'official detail offers no unsupported link to select the Scout tab');
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
    installBundle: () => assert.fail('installed plugin: no install'), removeBundle: () => assert.fail('never remove'), setBundleEnabled: () => assert.fail('never toggle without a click'),
  };
  const ctx = mockContext({ remote: { $on: () => () => {} }, 'remote.pluginManager': pm, pluginNavigation: { openBundle: () => assert.fail('embedded tab must use its owner openPackage callback') }, layout: { selectPanel: (p) => opened.push(['panel', p]) } });
  client.apply(ctx);
  const Page = ctx.registrations.find((r) => r.options.name === 'plugins.tab').component;
  const v = await render(React.createElement(Page, { openPackage: (name) => opened.push(['package', name]) }));
  await flush();
  const items = v.container.querySelectorAll('.scx-item');
  assert.equal(items.length, 2);
  const results = v.container.querySelector('[role="region"][aria-label="插件列表"]');
  assert.ok(results.contains(items[0]));
  assert.equal(results.tabIndex, 0, 'list is keyboard-scrollable');
  assert.equal(results.contains(v.container.querySelector('.scx-cats')), false);
  assert.equal(results.contains(v.container.querySelector('.scx-lhead')), false);
  assert.ok(Number.parseFloat(v.container.querySelector('[data-scout-page]').style.height) >= 0);
  const search = v.container.querySelector('.scx-search input');
  assert.equal(search.type, 'search');
  assert.equal(search.placeholder, '搜索插件');
  assert.equal(search.title, '名称、描述、仓库、分类');
  assert.ok(v.container.querySelector('.scx-search svg[aria-hidden="true"]'));
  assert.doesNotMatch(v.container.querySelector('.scx-search').textContent, /⌕/);
  assert.equal(v.container.querySelector('h1'), null, 'official Plugins page owns the page heading');
  assert.equal(v.container.querySelector('.scx-top h1, .scx-sub'), null, 'embedded tab has no duplicate page title or subtitle');
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
  assert.deepEqual(opened, [['package', 'alpha']], 'installed bundle navigation goes through the official tab owner');
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
  assert.ok(find(d2, 'button', /^安装$/), 'one-click install offered next to the fallback');

  await v.close();
  ctx.dispose();
});

test('installed bundle falls back to official Plugins when the owner openPackage callback is unavailable', async () => {
  const opened = [];
  const ctx = mockContext({
    'remote.pluginManager': { listBundles: async () => ({ ok: true, value: [{ name: 'alpha', installed: true }] }) },
    pluginNavigation: { openBundle: () => assert.fail('do not use pluginNavigation as a substitute tab owner') },
    layout: { selectPanel: (panel) => opened.push(panel) },
  });
  client.apply(ctx);
  const { v, drawer } = await openDrawer(ctx, 0);
  await act(async () => find(drawer, 'button', /在插件页打开/).click());
  assert.deepEqual(opened, ['plugins']);
  await v.close();
  ctx.dispose();
});

// A bounded wait observes completed renders rather than depending on a particular fetch speed.
async function until(check, message) {
  for (let i = 0; i < 40; i++) {
    if (check()) return;
    await flush(15);
  }
  assert.ok(check(), message);
}

// Override only this test's API and always restore it, including on an assertion failure.
async function withPagedScout(run, { polling = false } = {}) {
  const originalFetch = globalThis.fetch;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const timers = new Map();
  let poll, interval, running = polling === true;
  if (polling) {
    globalThis.setInterval = (callback, ms, ...args) => {
      if (ms === 1500 || ms === 30000) {
        poll = callback; interval = ms;
        const id = Symbol('status poll');
        timers.set(id, ms);
        return id;
      }
      return originalSetInterval(callback, ms, ...args);
    };
    globalThis.clearInterval = (id) => {
      if (!timers.delete(id)) originalClearInterval(id);
    };
  }
  const ctx = mockContext();
  const rows = Array.from({ length: 125 }, (_, i) => row(`plugin-${String(i).padStart(3, '0')}`, `owner/plugin-${i}`, 90));
  const calls = [];
  const pending = [];
  let total = rows.length, rev = 1, deferNext = false, v;
  const ok = (value) => ({ status: 200, json: async () => ({ ok: true, value }) });
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url, 'http://localhost');
    if (u.pathname === '/dsh-plugin-scout/api/status' || u.pathname === '/dsh-plugin-scout/api/refresh') {
      if (u.pathname.endsWith('/refresh')) rev++;
      const response = await originalFetch('/dsh-plugin-scout/api/status', init);
      const payload = await response.json();
      return ok({ ...payload.value, loaded: true, running, rev });
    }
    if (u.pathname !== '/dsh-plugin-scout/api/list') return originalFetch(url, init);
    assert.equal(init.headers['x-dsh-plugin-scout'], '1');
    assert.equal(init.credentials, 'same-origin');
    assert.equal(init.method, 'POST');
    const params = JSON.parse(init.body);
    calls.push(params);
    const offset = Number(params.offset), limit = Number(params.limit);
    assert.equal(limit, 60, 'fixed page size, never an expanding limit');
    const ordered = rows.slice(0, total);
    if (params.sort === 'name') ordered.reverse();
    const response = ok({ total, cats: { all: total, memory: total }, rows: ordered.slice(offset, offset + limit) });
    if (deferNext) {
      deferNext = false;
      // Deliberately ignore cancellation: the client must invalidate late responses itself.
      return new Promise((resolve) => pending.push(() => resolve(response)));
    }
    return response;
  };
  try {
    client.apply(ctx);
    const Page = ctx.registrations.find((r) => r.options.name === 'plugins.tab').component;
    v = await render(React.createElement(Page));
    await until(() => v.container.querySelectorAll('.scx-item').length === 60, 'first page loaded');
    await run({
      container: v.container, calls, pending,
      shrink(n) { total = n; },
      defer() { deferNext = true; },
      async publish() { assert.equal(typeof poll, 'function'); rev++; await act(async () => poll()); },
      async pollStatus() { assert.equal(typeof poll, 'function'); await act(async () => poll()); },
      setRunning(value) { running = value; },
      pollInterval() { return interval; },
      activeTimers() { return [...timers.values()]; },
    });
  } finally {
    for (const resolve of pending) resolve();
    if (v) await v.close();
    ctx.dispose();
    globalThis.fetch = originalFetch;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    assert.equal(timers.size, 0, 'status polling is cleaned up on unmount');
  }
}

const pagination = (c) => c.querySelector('nav[aria-label="插件分页"]');
const pageButton = (c, label) => find(pagination(c), 'button', new RegExp(`^${label}$`));
const itemRepos = (c) => [...c.querySelectorAll('.scx-item')].map((el) => el.dataset.repo);

async function goPage(c, label, status) {
  await act(async () => pageButton(c, label).click());
  await until(() => pagination(c).textContent.includes(status) && c.querySelectorAll('.scx-item').length > 0 && !c.querySelector('.scx-results').textContent.includes('加载中…'), `loaded ${status}`);
}

test('pagination replaces 60-row pages, bounds navigation, keeps controls outside results and resets scroll', async () => {
  await withPagedScout(async ({ container: c, calls }) => {
    const results = c.querySelector('.scx-results');
    const nav = pagination(c);
    assert.ok(nav, 'accessible bottom navigation');
    assert.equal(results.contains(nav), false);
    assert.ok(results.compareDocumentPosition(nav) & browser.Node.DOCUMENT_POSITION_FOLLOWING, 'navigation follows results');
    assert.doesNotMatch(c.textContent, /再显示/);
    assert.match(nav.textContent, /第 1 \/ 3 页 · 共 125 个/);
    assert.equal(pageButton(c, '上一页').disabled, true);
    assert.equal(pageButton(c, '下一页').disabled, false);
    assert.deepEqual(itemRepos(c), Array.from({ length: 60 }, (_, i) => `owner/plugin-${i}`));
    results.scrollTop = 350;
    await goPage(c, '下一页', '第 2 / 3 页');
    assert.equal(results.scrollTop, 0);
    assert.deepEqual(itemRepos(c), Array.from({ length: 60 }, (_, i) => `owner/plugin-${i + 60}`));
    assert.equal(pageButton(c, '上一页').disabled, false);
    await act(async () => pageButton(c, '下一页').click());
    await until(() => c.querySelectorAll('.scx-item').length === 5, 'last page loaded');
    assert.deepEqual(itemRepos(c), Array.from({ length: 5 }, (_, i) => `owner/plugin-${i + 120}`));
    assert.match(nav.textContent, /第 3 \/ 3 页 · 共 125 个/);
    assert.equal(pageButton(c, '下一页').disabled, true);
    const before = calls.length;
    await act(async () => pageButton(c, '下一页').click());
    await flush(20);
    assert.equal(calls.length, before, 'last-page next does not fetch');
    await goPage(c, '上一页', '第 2 / 3 页');
    await goPage(c, '上一页', '第 1 / 3 页');
    assert.equal(pageButton(c, '上一页').disabled, true);
    const offsets = calls.map((p) => Number(p.offset));
    // Initial status/revision arrival may revalidate the first page.
    assert.deepEqual(offsets.filter((value, i) => i === 0 || value !== offsets[i - 1]), [0, 60, 120, 60, 0]);
    assert.ok(calls.every((p) => p.limit === 60), 'requests never grow the page size');
    assert.ok(calls.every((p) => p.sort === 'stars'), 'default query sorts by stars');
    assert.equal(c.querySelector('select[aria-label="排序"]').value, 'stars');
    const jump = c.querySelector('input[aria-label="跳转页码"]');
    const form = jump.closest('form');
    const nativeSet = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value').set;
    for (const value of ['0', '4', '1.5', '']) {
      await act(async () => { nativeSet.call(jump, value); Simulate.change(jump); });
      const count = calls.length;
      await act(async () => form.dispatchEvent(new browser.Event('submit', { bubbles: true, cancelable: true })));
      await flush(10);
      assert.equal(calls.length, count, `invalid page ${value} never fetches`);
    }
    await act(async () => { nativeSet.call(jump, '3'); Simulate.change(jump); });
    await act(async () => form.dispatchEvent(new browser.Event('submit', { bubbles: true, cancelable: true })));
    await until(() => itemRepos(c).length === 5, 'direct jump to last page');
    assert.equal(calls.at(-1).offset, 120);
    assert.equal(jump.value, '');
  });
});

test('sorting and filters reset pagination; a shrinking host total clamps and refetches the last page', async () => {
  await withPagedScout(async ({ container: c, calls, shrink }) => {
    await goPage(c, '下一页', '第 2 / 3 页');
    const select = c.querySelector('select[aria-label="排序"]');
    await act(async () => { select.value = 'name'; select.dispatchEvent(new browser.Event('change', { bubbles: true })); });
    await until(() => calls.at(-1).sort === 'name' && itemRepos(c)[0] === 'owner/plugin-124', 'sort applied on first page');
    assert.equal(Number(calls.at(-1).offset), 0);
    assert.match(pagination(c).textContent, /第 1 \/ 3 页/);
    await goPage(c, '下一页', '第 2 / 3 页');
    await act(async () => c.querySelector('.scx-filters input[type="checkbox"]').click());
    await until(() => Number(calls.at(-1).offset) === 0 && !pageButton(c, '下一页').disabled, 'filter reset to first page');
    assert.match(pagination(c).textContent, /第 1 \/ 3 页/);
    await goPage(c, '下一页', '第 2 / 3 页');
    await act(async () => pageButton(c, '下一页').click());
    await until(() => c.querySelectorAll('.scx-item').length === 5, 'third page loaded');
    const before = calls.length;
    shrink(65);
    await act(async () => find(c, '.scx-fresh button', /^刷新$/).click());
    await until(() => pagination(c).textContent.includes('第 2 / 2 页 · 共 65 个') && c.querySelectorAll('.scx-item').length === 5, 'clamped last page refetched');
    assert.deepEqual(calls.slice(before).map((p) => Number(p.offset)), [120, 60]);
    assert.deepEqual(itemRepos(c), ['owner/plugin-4', 'owner/plugin-3', 'owner/plugin-2', 'owner/plugin-1', 'owner/plugin-0']);
    assert.equal(pageButton(c, '下一页').disabled, true);
    assert.equal(pageButton(c, '上一页').disabled, false);
  });
});

test('idle polling discovers host refreshes and revisions, switches cadence and cleans up its timer', async () => {
  await withPagedScout(async ({ container: c, calls, publish, pollStatus, setRunning, pollInterval, activeTimers }) => {
    await goPage(c, '下一页', '第 2 / 3 页');
    const results = c.querySelector('.scx-results');
    results.scrollTop = 340;
    assert.equal(pollInterval(), 30000);
    assert.deepEqual(activeTimers(), [30000]);
    const before = calls.length;
    await pollStatus();
    await flush(20);
    assert.equal(calls.length, before, 'unchanged idle status does not refetch rows');
    await publish();
    await until(() => calls.length > before, 'idle revision revalidates visible page');
    assert.equal(calls.at(-1).offset, 60);
    assert.equal(results.scrollTop, 340);
    assert.match(pagination(c).textContent, /第 2 \/ 3 页/);
    setRunning(true);
    await pollStatus();
    assert.equal(pollInterval(), 1500, 'host-started refresh activates fast polling');
    assert.deepEqual(activeTimers(), [1500], 'old idle timer is removed');
    assert.ok(find(c, '.scx-fresh button', /^刷新中…$/));
    setRunning(false);
    await publish();
    assert.equal(pollInterval(), 30000);
    assert.deepEqual(activeTimers(), [30000], 'completion returns to one idle timer');
    assert.equal(results.scrollTop, 340);
  }, { polling: 'idle' });
});

test('background revisions retain visible rows, page and scroll while pending and after completion', async () => {
  await withPagedScout(async ({ container: c, calls, pending, defer, publish }) => {
    await goPage(c, '下一页', '第 2 / 3 页');
    const results = c.querySelector('.scx-results');
    const first = results.querySelector('.scx-item');
    results.scrollTop = 350;
    defer();
    await publish();
    await until(() => pending.length === 1, 'revision request pending');
    assert.equal(calls.at(-1).offset, 60, 'revalidate the current page');
    assert.equal(results.querySelector('.scx-item'), first, 'keep row DOM mounted to avoid browser scroll clamping');
    assert.equal(itemRepos(c).length, 60);
    assert.doesNotMatch(results.textContent, /加载中…/);
    assert.equal(results.scrollTop, 350);
    assert.equal(pageButton(c, '下一页').disabled, false, 'background work does not block navigation');
    results.scrollTop = 480;
    await act(async () => pending.shift()());
    await flush(20);
    assert.equal(results.querySelector('.scx-item'), first);
    assert.equal(results.scrollTop, 480, 'preserve scrolling performed during revalidation');
    assert.match(pagination(c).textContent, /第 2 \/ 3 页/);
    await goPage(c, '下一页', '第 3 / 3 页');
    assert.equal(results.scrollTop, 0, 'subsequent user navigation still resets');
  }, { polling: true });
});

test('a revision during pending user navigation still resets scroll; superseded background replies cannot replace a filter', async () => {
  await withPagedScout(async ({ container: c, calls, pending, defer, publish }) => {
    const results = c.querySelector('.scx-results');
    results.scrollTop = 300;
    defer();
    await act(async () => pageButton(c, '下一页').click());
    await until(() => pending.length === 1, 'user navigation pending');
    await publish();
    await until(() => itemRepos(c)[0] === 'owner/plugin-60', 'revision completes requested page');
    assert.equal(results.scrollTop, 0, 'revision does not swallow pending navigation reset');
    await act(async () => pending.shift()());
    results.scrollTop = 260;
    defer();
    await publish();
    await until(() => pending.length === 1, 'background refresh pending');
    await act(async () => c.querySelector('.scx-filters input[type="checkbox"]').click());
    await until(() => calls.at(-1).compat.includes('ok') && itemRepos(c)[0] === 'owner/plugin-0', 'filter loaded first page');
    assert.equal(results.scrollTop, 0);
    results.scrollTop = 120;
    await act(async () => pending.shift()());
    await flush(20);
    assert.equal(itemRepos(c)[0], 'owner/plugin-0');
    assert.match(pagination(c).textContent, /第 1 \/ 3 页/);
    assert.equal(results.scrollTop, 120, 'late background reply cannot move current scroll');
    await act(async () => c.querySelector('.scx-filters input[type="checkbox"]').click());
    await until(() => calls.at(-1).compat.length === 0 && results.getAttribute('aria-busy') === 'false', 'filter changes on page one finish');
    assert.equal(results.scrollTop, 0, 'filters reset even without a page-number change');
  }, { polling: true });
});

test('pending pages hide stale rows and disable navigation; a cancelled late reply cannot overwrite newer sorting', async () => {
  await withPagedScout(async ({ container: c, calls, pending, defer }) => {
    const results = c.querySelector('.scx-results');
    results.scrollTop = 280;
    defer();
    await act(async () => pageButton(c, '下一页').click());
    await until(() => pending.length === 1, 'second-page request is pending');
    assert.equal(c.querySelectorAll('.scx-item').length, 0, 'no stale first-page rows while loading');
    assert.match(results.textContent, /加载中…/);
    assert.equal(pageButton(c, '上一页').disabled, true);
    assert.equal(pageButton(c, '下一页').disabled, true);
    assert.equal(results.scrollTop, 280, 'scroll resets on success, not before the response');
    const select = c.querySelector('select[aria-label="排序"]');
    await act(async () => { select.value = 'name'; select.dispatchEvent(new browser.Event('change', { bubbles: true })); });
    await until(() => itemRepos(c)[0] === 'owner/plugin-124', 'new sorted first page loaded');
    assert.equal(Number(calls.at(-1).offset), 0);
    assert.equal(results.scrollTop, 0);
    await act(async () => pending.shift()());
    await flush(20);
    assert.deepEqual(itemRepos(c), Array.from({ length: 60 }, (_, i) => `owner/plugin-${124 - i}`));
    assert.match(pagination(c).textContent, /第 1 \/ 3 页 · 共 125 个/);
    assert.equal(pageButton(c, '上一页').disabled, true);
    assert.equal(pageButton(c, '下一页').disabled, false);
  });
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
      bind() { return (k) => k === 'panel' ? 'Scout' : k; }
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
    assert.deepEqual(seen.sort(), ['plugins.detail.badge', 'plugins.detail.section', 'plugins.tab']);
    await fiber.dispose();
    void listed;
  }
  document.querySelectorAll('style[data-scout]').forEach((s) => s.remove());
});

test('without the official pluginManager the page still works and inspect is hidden', async () => {
  const ctx = mockContext();
  client.apply(ctx);
  const Page = ctx.registrations.find((r) => r.options.name === 'plugins.tab').component;
  const v = await render(React.createElement(Page));
  await flush();
  await act(async () => v.container.querySelector('.scx-item').click());
  await flush();
  const drawer = document.querySelector('[data-scout-drawer]');
  assert.equal(find(drawer, 'button', /^预检/), undefined);
  assert.equal(find(drawer, 'button', /^安装$/), undefined, 'no official installer → no install button, only copy + jump');
  await v.close();
  ctx.dispose();
});

/** 假官方 pluginManager：记录调用，按脚本给出 installBundle 的结果；会发 install-state 事件。 */
function fakeManager(script) {
  const calls = [];
  const handlers = {};
  const pm = {
    listBundles: async () => ({ ok: true, value: [] }),
    inspect: async (spec, o) => { calls.push(['inspect', spec, o]); return { ok: true, value: { status: 'accepted', kind: 'registry', name: spec.split('@')[0], version: '1.0.0', bundle: true, registry: 'https://registry.npmjs.org/' } }; },
    installBundle: async (spec, o) => {
      calls.push(['installBundle', spec, o]);
      handlers['plugin-manager/install-state']?.({ requestId: o.requestId, phase: 'installing' });
      handlers['plugin-manager/install-log']?.({ requestId: o.requestId, text: 'Progress: resolved 12\n' });
      return script.shift()(spec, o);
    },
    setBundleEnabled: async (name, on) => { calls.push(['setBundleEnabled', name, on]); return { ok: true, value: { changed: true, application: 'applied', stage: 'enable', target: name } }; },
    cancelInstall: async (id) => { calls.push(['cancelInstall', id]); return { ok: true, value: { status: 'cancelled' } }; },
    removeBundle: () => assert.fail('scout never uninstalls'),
  };
  const remote = { $on: (e, fn) => { handlers[e] = fn; return () => { delete handlers[e]; }; } };
  return { pm, remote, calls };
}

async function openDrawer(ctx, index) {
  const Page = ctx.registrations.find((r) => r.options.name === 'plugins.tab').component;
  const v = await render(React.createElement(Page));
  await flush();
  await act(async () => v.container.querySelectorAll('.scx-item')[index].click());
  await flush();
  return { v, drawer: document.querySelector('[data-scout-drawer]') };
}

test('one-click install goes through official inspect → installBundle(enabled:false), then enable is a separate click', async () => {
  const { pm, remote, calls } = fakeManager([(spec) => ({ ok: true, value: { changed: true, application: 'applied', stage: 'install', target: spec, bundle: 'alpha' } })]);
  const ctx = mockContext({ remote, 'remote.pluginManager': pm, layout: { selectPanel() {} } });
  client.apply(ctx);
  const { v, drawer } = await openDrawer(ctx, 0);
  await act(async () => find(drawer, 'button', /^安装$/).click());
  await flush();
  assert.deepEqual(calls.map((c) => c[0]), ['inspect', 'installBundle'], 'inspect first, then the official installer');
  const opts = calls[1][2];
  assert.equal(calls[1][1], 'alpha@1.0.0', 'pinned spec');
  assert.equal(opts.enabled, false, 'installed disabled, like the official page');
  assert.equal(opts.registry, 'https://registry.npmjs.org/', 'install from the registry inspect answered from');
  assert.equal(typeof opts.requestId, 'string');
  assert.equal(opts.approvedBuilds, undefined, 'never pre-approves scripts');
  assert.match(drawer.querySelector('.scx-inst').textContent, /已安装，尚未启用/);
  assert.equal(find(drawer, 'button', /^安装$/), undefined);
  await act(async () => find(drawer, 'button', /^启用$/).click());
  await flush();
  assert.deepEqual(calls.at(-1), ['setBundleEnabled', 'alpha', true]);
  assert.match(drawer.querySelector('.scx-inst').textContent, /已启用/);
  await v.close();
  ctx.dispose();
});

test('risky plugin needs a second click; blocked install scripts are shown and only approved on explicit double click', async () => {
  const { pm, remote, calls } = fakeManager([
    () => ({ ok: true, value: { changed: false, application: 'failed', stage: 'install', target: 'github:x/evil', pendingBuilds: ['esbuild', 'evil'], packageResult: { exitCode: 1, output: '', truncated: false, logPath: '/p/.plugin-manager/logs/1.log', kind: 'build-blocked' } } }),
    () => ({ ok: true, value: { changed: false, application: 'failed', stage: 'install', target: 'github:x/evil', error: { code: 'incompatible-version', incompatible: [{ name: 'evil', version: '0.1.0', runtimeVersion: '0.2.0-rc.2', peers: { '@deepseek-ai/dsh': '^0.1.0' } }] } } }),
  ]);
  const ctx = mockContext({ remote, 'remote.pluginManager': pm, layout: { selectPanel() {} } });
  client.apply(ctx);
  const { v, drawer } = await openDrawer(ctx, 1);
  await act(async () => find(drawer, 'button', /^安装$/).click());
  await flush();
  assert.deepEqual(calls, [], 'first click on a risky plugin only arms');
  await act(async () => find(drawer, 'button', /再点一次确认安装/).click());
  await flush();
  assert.equal(calls.filter((c) => c[0] === 'installBundle').length, 1);
  const box = drawer.querySelector('.scx-inst');
  assert.equal(box.dataset.phase, 'failed');
  assert.match(box.textContent, /esbuild、evil/);
  assert.match(box.textContent, /1\.log/);
  await act(async () => find(drawer, 'button', /^允许这些脚本并重试$/).click());
  await flush();
  assert.equal(calls.filter((c) => c[0] === 'installBundle').length, 1, 'approval needs a second click too');
  await act(async () => find(drawer, 'button', /再点一次：允许这些脚本并重试/).click());
  await flush();
  const retry = calls.filter((c) => c[0] === 'installBundle')[1][2];
  assert.deepEqual(retry.approvedBuilds, ['esbuild', 'evil']);
  assert.match(drawer.querySelector('.scx-inst').textContent, /不兼容：evil@0\.1\.0 要求 @deepseek-ai\/dsh \^0\.1\.0，当前运行时 0\.2\.0-rc\.2/);
  await v.close();
  ctx.dispose();
});

test('install can be cancelled through official cancelInstall; lost reply falls back to waitForInstall', async () => {
  let finish;
  const { pm, remote, calls } = fakeManager([(spec, o) => new Promise((r) => { finish = () => r({ ok: false, error: { message: 'connection reset' } }); void o; })]);
  pm.waitForInstall = async (id) => { calls.push(['waitForInstall', id]); return { ok: true, value: { changed: false, application: 'cancelled', stage: 'install', target: 'alpha@1.0.0' } }; };
  const ctx = mockContext({ remote, 'remote.pluginManager': pm, layout: { selectPanel() {} } });
  client.apply(ctx);
  const { v, drawer } = await openDrawer(ctx, 0);
  await act(async () => find(drawer, 'button', /^安装$/).click());
  await flush();
  assert.match(drawer.querySelector('.scx-inst').textContent, /pnpm/, 'official install-state is reflected');
  assert.match(drawer.textContent, /Progress: resolved 12/, 'last install-log line shown');
  await act(async () => find(drawer, 'button', /取消安装/).click());
  await flush();
  const id = calls.find((c) => c[0] === 'installBundle')[2].requestId;
  assert.deepEqual(calls.find((c) => c[0] === 'cancelInstall'), ['cancelInstall', id]);
  await act(async () => finish());
  await flush();
  assert.deepEqual(calls.at(-1), ['waitForInstall', id]);
  assert.match(drawer.querySelector('.scx-inst').textContent, /已取消/);
  await v.close();
  ctx.dispose();
});
