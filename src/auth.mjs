// Host-only credential operations. Never project upstream bodies or secret values.
export const TOKEN_REF = 'DSH_SCOUT_GITHUB_TOKEN';
const result = (ok, code, message) => ({ ok, code, message });
export function createAuth({ credentials, fallback, fetch = globalThis.fetch }) {
  let active = false;
  const usable = () => !!credentials && ['resolve', 'describe', 'set', 'unset'].every((k) => typeof credentials[k] === 'function');
  async function resolve() {
    if (usable()) {
      const hit = await credentials.resolve(TOKEN_REF);
      if (hit?.value) return { token: hit.value, source: hit.source === 'file' ? 'DSH credentials' : ['env', 'dotenv', 'project-env', 'home-env'].includes(hit.source) ? `DSH credentials (${hit.source})` : 'DSH credentials' };
    }
    return fallback();
  }
  async function describe() {
    const info = usable() ? await credentials.describe(TOKEN_REF) : {};
    const hit = await resolve();
    return { configured: !!hit.token, source: hit.source ?? 'none', writable: usable() && info.writable === true, stored: info.configured === true && info.source === 'file', storage: 'credentials' };
  }
  async function check() {
    const { token } = await resolve();
    if (!token) return result(false, 'no-token', '尚未配置 GitHub Token，请保存 Token 或完成 gh 登录后重新检测');
    try {
      const res = await fetch('https://api.github.com/graphql', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ rateLimit { remaining } }' }) });
      if (res.status === 401) return result(false, 'invalid-token', 'Token 无效或已过期，请重新配置');
      if (res.status === 429 || (res.status === 403 && (res.headers?.get('x-ratelimit-remaining') === '0' || res.headers?.get('retry-after')))) return result(false, 'rate-limit', 'GitHub 请求额度已用尽，请稍后重试');
      if (res.status === 403) return result(false, 'permission', 'GitHub 拒绝访问，请检查 Token 权限或组织策略');
      if (!res.ok) return result(false, 'github-error', 'GitHub 暂时不可用，请稍后重试');
      const body = await res.json();
      if (body.errors?.some((e) => e.type === 'RATE_LIMITED' || e.extensions?.code === 'RATE_LIMITED')) return result(false, 'rate-limit', 'GitHub 请求额度已用尽，请稍后重试');
      if (body.errors?.length || !Number.isFinite(body.data?.rateLimit?.remaining)) return result(false, 'permission', 'Token 无法访问 GitHub GraphQL，请检查权限');
      if (body.data.rateLimit.remaining === 0) return result(false, 'rate-limit', 'GitHub 请求额度已用尽，请稍后重试');
      return result(true, 'connected', 'GitHub 连接成功');
    } catch { return result(false, 'network', 'GitHub 连接失败或超时，请检查网络后重试'); }
  }
  return {
    resolve,
    async run(action = 'describe', token) {
      if (active) throw Object.assign(new Error('GitHub 设置操作正在进行，请稍后重试'), { status: 409 });
      active = true;
      try {
        if (action === 'save' || action === 'clear') {
          const info = usable() ? await credentials.describe(TOKEN_REF) : {};
          if (!info.writable) throw Object.assign(new Error('当前宿主不支持保存凭证，请使用 gh 登录或环境变量'), { status: 503 });
          if (action === 'save') {
            if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,4096}$/.test(token.trim())) throw Object.assign(new Error('请输入有效的 GitHub Token'), { status: 400 });
            await credentials.set(TOKEN_REF, token.trim());
          } else await credentials.unset(TOKEN_REF);
        } else if (!['describe', 'check'].includes(action)) throw Object.assign(new Error('不支持的认证操作'), { status: 400 });
        return { ...await describe(), ...(action === 'check' ? { check: await check() } : {}) };
      } finally { active = false; }
    },
  };
}
