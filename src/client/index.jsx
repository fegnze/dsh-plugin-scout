// DSH Plugin Scout — Client 半边。
// 接缝只用公开扩展点：sidebar.panellist + main（发现页），plugins.detail.badge / plugins.detail.section（官方插件页），
// 以及官方 remote.pluginManager：listBundles / inspect（只读），installBundle（enabled:false）/ setBundleEnabled(true) / cancelInstall
// 用于抽屉里的一键安装——与官方「添加插件」同一条路径，兼容拒装、脚本拦截、失败回滚都由官方负责。
// 不调用 removeBundle、不写版本豁免、不碰 pnpm 与 profile 文件。
import React, { useSyncExternalStore } from 'react';
import { ScoutPage } from './Page.jsx';
import { Checklist } from './Drawer.jsx';
import { createBadgeCache } from './api.js';
import { createInstaller } from './installer.js';
import { band } from './view.js';
import css from './style.css';

export const PKG = 'dsh-plugin-scout';
export const PANEL_ID = 'dsh-plugin-scout';
const NS = 'dshPluginScout';
const OFFICIAL_PANEL = 'plugins';

export const inject = ['slots', 'locale'];

const zh = { panel: '发现插件', badge: '可信度', section: '插件发现 · 核验' };
const en = { panel: 'Discover', badge: 'Trust', section: 'Plugin Scout · checks' };

function optional(ctx, name) {
  try { return ctx.get?.(name); } catch { return undefined; }
}

/**
 * 官方 pluginManager Remote：只读方法。拿不到时返回 undefined，界面降级。
 * 注意：真实 cordis 里 remote 是按调用方代理的服务，读嵌套服务属性 remote.pluginManager
 * 会抛 cannot get property "remote.pluginManager" without inject——曾因此让整个 web boot 失败。
 * 所以只走 ctx.get（不检查 inject），且每一步都在 try 里。
 */
export function pluginManagerOf(ctx) {
  try {
    const pm = optional(ctx, 'remote.pluginManager');
    if (!pm || typeof pm.listBundles !== 'function') return undefined;
    return { pm, remote: optional(ctx, 'remote') };
  } catch { return undefined; }
}

/** 已安装包名：listBundles 中 installed 的名字；监听官方 plugin-manager/changed。 */
export function createInstalledStore(ctx) {
  let names = [];
  const listeners = new Set();
  const emit = () => { for (const l of listeners) l(); };
  const load = async () => {
    const got = pluginManagerOf(ctx);
    if (!got) return;
    try {
      const res = await got.pm.listBundles();
      const list = res?.ok ? res.value : Array.isArray(res) ? res : [];
      const next = list.filter((b) => b.installed).map((b) => b.name).sort();
      if (next.join('\n') !== names.join('\n')) { names = next; emit(); }
    } catch { /* 官方服务暂不可用：保持上次结果 */ }
  };
  return {
    load,
    get: () => names,
    subscribe: (l) => { listeners.add(l); if (listeners.size === 1) void load(); return () => listeners.delete(l); },
    watch(extra = {}) {
      const got = pluginManagerOf(ctx);
      const offs = [];
      try { const off = got?.remote?.$on?.('plugin-manager/changed', load); if (typeof off === 'function') offs.push(off); } catch { /* optional */ }
      for (const [event, fn] of Object.entries(extra)) {
        try { const off = got?.remote?.$on?.(event, fn); if (typeof off === 'function') offs.push(off); } catch { /* optional */ }
      }
      try { const off = ctx.on?.('connection/reset', load); if (typeof off === 'function') offs.push(off); } catch { /* optional */ }
      return () => offs.forEach((o) => o());
    },
  };
}

function installStyle() {
  if (typeof document === 'undefined') return () => {};
  const tag = document.createElement('style');
  // DSH 会把无主 style 归给下一个物化的插件；归属必须在插入 DOM 之前打上。
  tag.dataset.plugin = PKG;
  tag.dataset.pluginCss = `${PKG}/style`;
  tag.dataset.scout = PKG;
  tag.textContent = css;
  document.head.appendChild(tag);
  return () => tag.remove();
}

export function PanelIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="10.5" cy="10.5" r="6" />
        <path d="m15 15 5 5" />
        <path d="m8 10.5 1.8 1.8L13.2 9" />
      </g>
    </svg>
  );
}

const subjectName = (subject) => (subject?.kind === 'bundle' || subject?.kind === 'row' ? subject.pkg?.name : undefined);

export function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'scout: dictionaries');
  const t = ctx.locale.bind(NS);
  ctx.effect(installStyle, 'scout: stylesheet');

  const installed = createInstalledStore(ctx);
  const installer = createInstaller(() => pluginManagerOf(ctx), { onInstalled: () => void installed.load() });
  // 可选能力绝不能拖垮激活：watch 失败只降级，不抛出到 fiber。
  ctx.effect(() => {
    try {
      return installed.watch({ 'plugin-manager/install-state': (p) => installer.onState(p), 'plugin-manager/install-log': (c) => installer.onLog(c) });
    } catch { return undefined; }
  }, 'scout: installed watch');
  const badges = createBadgeCache();
  let pending;

  const face = {
    useInstalled: () => useSyncExternalStore(installed.subscribe, installed.get, installed.get),
    /** 一键安装：拿不到官方 installBundle 时为 undefined，界面退回「复制 + 去插件页」。 */
    installer: (() => { const got = pluginManagerOf(ctx); return got && typeof got.pm.installBundle === 'function' ? installer : undefined; })(),
    useInstall: (name) => useSyncExternalStore(installer.subscribe, () => installer.get()[name], () => undefined),
    inspect: pluginManagerOf(ctx) ? async (spec) => {
      try {
        const got = pluginManagerOf(ctx);
        if (!got) return { error: '官方插件管理服务暂不可用' };
        const res = await got.pm.inspect(spec, {});
        if (res?.ok === false) return { error: res.error?.message ?? 'failed' };
        return res?.ok ? res.value : res;
      } catch (e) { return { error: e.message }; }
    } : undefined,
    /** 已安装 → 直达官方详情；否则切到官方插件页。返回实际走了哪条路。 */
    openPlugins(name) {
      const nav = optional(ctx, 'pluginNavigation');
      if (name && typeof nav?.openBundle === 'function') { try { nav.openBundle(name); return 'bundle'; } catch { /* fall through */ } }
      const layout = optional(ctx, 'layout');
      if (typeof layout?.selectPanel === 'function') { try { layout.selectPanel(OFFICIAL_PANEL); return 'panel'; } catch { /* none */ } }
      return 'none';
    },
    takePending() { const p = pending; pending = undefined; return p; },
    onPending(fn) { pendingListeners.add(fn); return () => pendingListeners.delete(fn); },
  };
  const pendingListeners = new Set();
  const focus = (repo) => { pending = repo; for (const l of pendingListeners) l(); };

  function Page() { return <ScoutPage face={face} />; }

  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, Page)), 'scout: page');
  ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: () => t('panel'), locale: NS,
  }, PanelIcon)), 'scout: sidebar entry');

  const useBadge = (name) => {
    useSyncExternalStore(badges.subscribe, () => (name ? badges.get(name) : null), () => null);
    return name ? badges.get(name) : null;
  };

  function Badge({ subject }) {
    const b = useBadge(subject?.kind === 'bundle' ? subjectName(subject) : undefined);
    if (!b) return null;
    return <span className="scx-root scx-badge" data-band={band(b.score)} data-risky={b.risky} title={`dsh-plugin-scout · ${b.repo}`}>{t('badge')} {b.score}{b.risky ? ' · ✕' : ''}</span>;
  }

  function Section({ subject }) {
    const name = subject?.kind === 'bundle' ? subjectName(subject) : undefined;
    const b = useBadge(name);
    if (!b) return null;
    const goto = () => {
      focus(b.repo);
      const layout = optional(ctx, 'layout');
      try { layout?.selectPanel?.(PANEL_ID); } catch { /* optional */ }
    };
    return (
      <section className="scx-root scx-section" data-scout-section="">
        <h4>{t('section')}<span className="scx-badge" data-band={band(b.score)} data-risky={b.risky}>{b.score}</span><button type="button" className="scx-link" onClick={goto}>在发现页查看 →</button></h4>
        <div className="scx-ev" style={{ marginBottom: 8 }}>按包名匹配索引中的代表仓库 github.com/{b.repo}{b.npmVersion ? ` · npm 最新 ${b.npmVersion}` : ''}</div>
        <Checklist checks={b.checks} />
      </section>
    );
  }

  ctx.effect(() => ctx.slots.inject('plugins.detail.badge', () => ctx.slots.register({ name: 'plugins.detail.badge', id: `${PKG}/badge`, order: 50, locale: NS }, Badge)), 'scout: official badge');
  ctx.effect(() => ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({ name: 'plugins.detail.section', id: `${PKG}/section`, order: 50, locale: NS }, Section)), 'scout: official section');
}
