// 同源接口：Host 半边挂在 DSH 自己的 webServer 上，界面从不连第二个端口。
export const PREFIX = '/dsh-plugin-scout';

async function call(path, init = {}) {
  const res = await fetch(`${PREFIX}${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: { 'x-dsh-plugin-scout': '1', ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
  });
  let body;
  try { body = await res.json(); } catch { body = undefined; }
  if (!body || body.ok === false) {
    const err = new Error(body?.error?.message ?? `HTTP ${res.status}`);
    err.code = body?.error?.code ?? 'http';
    err.value = body?.value;
    throw err;
  }
  return body.value;
}

export const api = {
  status: () => call('/api/status'),
  list: (params) => call('/api/list', { method: 'POST', body: JSON.stringify(params) }),
  detail: (key) => call(`/api/detail?key=${encodeURIComponent(key)}`),
  badges: (names) => call('/api/badges', { method: 'POST', body: JSON.stringify({ names }) }),
  refresh: (full) => call('/api/refresh', { method: 'POST', body: JSON.stringify({ full: !!full }) }),
};

/** 合并同一帧内的徽章查询（官方插件页会一次渲染很多条）。 */
export function createBadgeCache(fetchBadges = api.badges) {
  const cache = new Map();
  const listeners = new Set();
  let pending = new Set();
  let timer;
  const flush = async () => {
    const names = [...pending];
    pending = new Set();
    timer = undefined;
    try {
      const got = await fetchBadges(names);
      for (const n of names) cache.set(n, got[n] ?? null);
    } catch {
      for (const n of names) cache.set(n, null);
    }
    for (const l of listeners) l();
  };
  return {
    get(name) {
      if (cache.has(name)) return cache.get(name);
      pending.add(name);
      timer ??= setTimeout(flush, 30);
      return undefined;
    },
    subscribe(l) { listeners.add(l); return () => listeners.delete(l); },
    clear() { cache.clear(); for (const l of listeners) l(); },
  };
}
