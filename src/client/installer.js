// 一键安装：只经官方 remote.pluginManager（与官方插件页「添加插件」同一条路径）。
// 官方服务负责 peer 兼容拒装、依赖脚本拦截（pendingBuilds）、失败回滚 package.json / pnpm-lock.yaml；
// 这里不碰 pnpm、不写 profile 文件、不做版本豁免。
// 与官方页一致：安装时 enabled:false，装好后由用户再点「启用」——不兼容或有缺陷的插件一旦被直接启用，
// 可能让 App 起不来（本插件自己就出过这种事）。

const PHASE_TEXT = {
  checking: '官方预检中…',
  starting: '正在提交给官方安装器…',
  installing: '官方安装器运行 pnpm 中…',
  cancelling: '正在取消…',
  applying: '正在写入 profile（此阶段不可取消）…',
  enabling: '正在启用…',
};

const CODE_TEXT = {
  'management-required': '当前 profile 不受插件管理器管理',
  unaddressable: '无法定位这个插件',
  'unknown-plugin': '官方不认识这个插件',
  'invalid-spec': '规格无效',
  'ambiguous-install': '规格对应多个包，无法确定装哪个',
  'not-bundle': '这个包没有声明 DSH 组合包，官方不接受',
  'not-removable': '不可移除',
  'stop-profile': '需要先停止当前 profile',
  'bundle-in-use': '组合包正在使用中',
  'stale-approval': '脚本批准已过期，请重新确认',
  'incompatible-version': '与当前 DSH 版本不兼容',
  'operation-error': '安装器内部错误',
};

const KIND_TEXT = {
  network: '网络不可达',
  timeout: '安装超时',
  integrity: '包校验失败',
  'pnpm-missing': '找不到 pnpm',
  'not-found': 'registry 上找不到',
  'no-matching-version': '没有匹配的版本',
  'disk-full': '磁盘已满',
  permission: '没有写权限',
  'build-blocked': '依赖带安装脚本，已被拦下',
};

const PROBLEM_TEXT = {
  'already-installed': '已经安装',
  'not-found': 'registry 上找不到',
  network: '网络不可达',
  'invalid-spec': '规格无效',
  'not-a-package': '不是 npm 包',
  'not-a-bundle': '不是 DSH 组合包',
  unknown: '未知原因',
};

/** 官方失败结果 → 一句人话（不含原始输出；原始日志路径另列）。 */
export function failureText(v) {
  const e = v?.error;
  if (e?.code === 'incompatible-version') {
    const named = (e.incompatible ?? v.packageResult?.incompatible ?? []).map((p) => `${p.name}@${p.version} 要求 ${Object.entries(p.peers).map(([k, r]) => `${k} ${r}`).join('、')}，当前运行时 ${p.runtimeVersion}`);
    return `${CODE_TEXT['incompatible-version']}${named.length ? `：${named.join('；')}` : ''}。如确需使用，可在官方插件页按版本豁免。`;
  }
  if (v?.pendingBuilds?.length) return `${KIND_TEXT['build-blocked']}：${v.pendingBuilds.join('、')}`;
  if (v?.failedAt === 'spec-host') return '连不上源码主机（GitHub），换网络或稍后重试';
  const kind = v?.packageResult?.kind;
  const head = (e?.code && CODE_TEXT[e.code]) || (kind && KIND_TEXT[kind]) || '安装失败';
  return e?.diagnostic ? `${head}：${e.diagnostic.slice(0, 300)}` : head;
}

const unwrap = (res) => (res && typeof res === 'object' && 'ok' in res ? res : { ok: true, value: res });
const uuid = () => (globalThis.crypto?.randomUUID?.() ?? `scout-${Date.now()}-${Math.random().toString(36).slice(2)}`);

/**
 * 每个包名一份安装状态；同一时刻只允许一次安装（官方也持 profile 锁串行）。
 * @param {() => ({pm:any, remote:any}|undefined)} getPm
 * @param {{onInstalled?:()=>void}} hooks
 */
export function createInstaller(getPm, { onInstalled } = {}) {
  let states = {};
  let active; // { name, requestId }
  const listeners = new Set();
  const set = (name, patch) => {
    states = { ...states, [name]: patch === null ? undefined : { ...states[name], ...patch } };
    for (const l of listeners) l();
  };
  const byRequest = (id) => (active && active.requestId === id ? active.name : undefined);

  async function settle(name, requestId, res) {
    let r = unwrap(res);
    if (!r.ok) {
      // 回复丢了不等于失败：问官方这次安装还在不在跑，在就等它的结果。
      try { r = unwrap(await getPm()?.pm.waitForInstall?.(requestId)); } catch { r = { ok: false }; }
      if (!r.ok || r.value == null) { set(name, { phase: 'unconfirmed', text: '没拿到安装结果；请到官方插件页确认是否已装上，再决定是否重试' }); return; }
    }
    const v = r.value;
    if (v.application === 'cancelled') set(name, { phase: 'cancelled', text: '已取消；官方已恢复 package.json 与 pnpm-lock.yaml' });
    else if (v.application === 'failed') set(name, { phase: 'failed', text: failureText(v), code: v.error?.code, pendingBuilds: v.pendingBuilds ?? [], logPath: v.packageResult?.logPath });
    else {
      set(name, { phase: 'installed', bundle: v.bundle ?? name, restartRequired: v.application === 'restart-required', text: v.application === 'restart-required' ? '已安装（需重启 DSH 生效）' : '已安装，尚未启用' });
      onInstalled?.();
    }
  }

  return {
    get: () => states,
    subscribe(l) { listeners.add(l); return () => listeners.delete(l); },
    busy: () => !!active,
    /** 官方 install-state / install-log 事件：只认自己发起的 requestId。 */
    onState(p) { const n = byRequest(p?.requestId); if (n && PHASE_TEXT[p.phase]) set(n, { phase: p.phase, text: PHASE_TEXT[p.phase] }); },
    onLog(c) {
      const n = byRequest(c?.requestId);
      if (!n || typeof c.text !== 'string') return;
      const line = c.text.split('\n').map((s) => s.trim()).filter(Boolean).at(-1);
      if (line) set(n, { log: line.slice(0, 200) });
    },
    /**
     * 先官方 inspect，再 installBundle（enabled:false）。approvedBuilds 只在用户看过名单、明确点了允许后才传。
     * @returns {Promise<void>}
     */
    async install(name, spec, approvedBuilds) {
      const got = getPm();
      if (!got || typeof got.pm.installBundle !== 'function') { set(name, { phase: 'failed', text: '当前窗口拿不到官方插件管理服务' }); return; }
      if (active) { set(name, { phase: 'failed', text: `正在安装 ${active.name}，请等它结束` }); return; }
      const requestId = uuid();
      active = { name, requestId };
      set(name, { phase: 'checking', text: PHASE_TEXT.checking, log: undefined, pendingBuilds: [], code: undefined, logPath: undefined, requestId });
      try {
        const insp = unwrap(await got.pm.inspect(spec, {}));
        if (!insp.ok) { set(name, { phase: 'failed', text: `官方预检失败：${insp.error?.message ?? 'unknown'}` }); return; }
        const iv = insp.value ?? {};
        if (iv.status !== 'accepted') {
          if (iv.problem === 'already-installed') { set(name, { phase: 'installed', text: '已经安装' }); onInstalled?.(); return; }
          set(name, { phase: 'failed', text: `官方预检拒绝：${PROBLEM_TEXT[iv.problem] ?? iv.problem}${iv.reason ? `（${iv.reason}）` : ''}` });
          return;
        }
        if (iv.bundle === false) { set(name, { phase: 'failed', text: '能解析到包，但它不是 DSH 组合包，官方不接受' }); return; }
        set(name, { phase: 'starting', text: PHASE_TEXT.starting });
        const res = await got.pm.installBundle(spec, { enabled: false, requestId, ...(iv.registry ? { registry: iv.registry } : {}), ...(approvedBuilds?.length ? { approvedBuilds: [...approvedBuilds] } : {}) });
        await settle(name, requestId, res);
      } catch (e) {
        set(name, { phase: 'failed', text: e?.message ?? String(e) });
      } finally {
        if (active?.requestId === requestId) active = undefined;
      }
    },
    async cancel(name) {
      const s = states[name];
      if (!active || active.name !== name || !s?.requestId) return;
      try {
        const r = unwrap(await getPm()?.pm.cancelInstall?.(s.requestId));
        if (r.ok && r.value?.status === 'too-late') set(name, { text: '已进入写入阶段，不能取消；等它完成' });
      } catch { /* 结果由 installBundle 的回复给出 */ }
    },
    async enable(name) {
      const got = getPm();
      if (!got || typeof got.pm.setBundleEnabled !== 'function') { set(name, { phase: 'failed', text: '当前窗口拿不到官方插件管理服务' }); return; }
      set(name, { phase: 'enabling', text: PHASE_TEXT.enabling });
      try {
        const r = unwrap(await got.pm.setBundleEnabled(states[name]?.bundle ?? name, true));
        if (!r.ok) { set(name, { phase: 'installed', text: `启用失败：${r.error?.message ?? 'unknown'}` }); return; }
        const v = r.value;
        if (v.application === 'failed') set(name, { phase: 'installed', text: `启用失败：${failureText(v)}；插件仍已安装，可在官方插件页处理或卸载` });
        else set(name, { phase: 'enabled', text: v.application === 'restart-required' ? '已启用，重启 DSH 后生效' : '已启用' });
        onInstalled?.();
      } catch (e) { set(name, { phase: 'installed', text: `启用失败：${e?.message ?? e}` }); }
    },
    reset(name) { if (!active || active.name !== name) set(name, null); },
  };
}
