// 纯展示逻辑（无 React、无 DSH），便于单测。
export const band = (score) => (score >= 70 ? 'hi' : score >= 45 ? 'mid' : 'lo');

export const ICON = { ok: '✓', warn: '!', bad: '✕', unk: '?' };

/** 列表行上的标签：主类/次类 + 风险/来源事实。 */
export function rowTags(r, labels, runtime, installed) {
  const t = [];
  if (!r.cats.length) t.push(['mute', '未归类']);
  else r.cats.slice(0, 2).forEach((id, i) => t.push([i ? 'cat2' : 'cat', labels[id] ?? id]));
  t.push(r.compat === 'ok' ? ['ok', `兼容 ${runtime}`] : r.compat === 'incompatible' ? ['warn', '不兼容当前版本'] : ['mute', '未声明兼容']);
  if (r.hooks.length) t.push(['bad', `安装脚本 · ${r.hooks.join('/')}`]);
  if (r.chain === 'mismatch') t.push(['bad', '来源链不一致']);
  if (r.chain === 'unpublished') t.push(['warn', '仅 Git']);
  if (r.provenance) t.push(['ok', 'provenance']);
  if (r.archived) t.push(['bad', '已归档']);
  t.push(['info', r.kinds.includes('client') ? '宿主 + 界面' : '仅宿主']);
  if (r.copies > 1) t.push(['mute', r.shadowOf ? `副本 · 代表 ${r.shadowOf}` : `${r.copies - 1} 个同名副本`]);
  if (installed) t.push(['mute', '已安装']);
  return t;
}

export function ago(iso, now = Date.now()) {
  if (!iso) return '从未';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 90) return '刚刚';
  if (s < 5400) return `${Math.round(s / 60)} 分钟前`;
  if (s < 129600) return `${Math.round(s / 3600)} 小时前`;
  return `${Math.round(s / 86400)} 天前`;
}

export function progressText(p) {
  if (!p) return '准备中…';
  if (p.phase === 'github') return `GitHub ${p.repos.toLocaleString()} / ~${(p.expected ?? 0).toLocaleString()} 仓库`;
  if (p.phase === 'npm') return `npm ${p.done} / ${p.total}`;
  return '…';
}

export function progressRatio(p) {
  if (!p) return 0;
  if (p.phase === 'github') return p.expected ? Math.min(0.85, (p.repos / p.expected) * 0.85) : 0.05;
  if (p.phase === 'npm') return 0.85 + (p.total ? (p.done / p.total) * 0.15 : 0);
  return 0;
}

/** 官方 inspect 结果的人话版本。 */
export function inspectText(result) {
  if (!result) return null;
  if (result.error) return { tone: 'bad', text: `调用失败：${result.error}` };
  if (result.status === 'accepted') {
    const v = [result.name, result.version].filter(Boolean).join('@');
    if (result.bundle === false) return { tone: 'bad', text: `能解析到 ${v}，但它不是组合包，官方插件页不会接受` };
    return { tone: 'ok', text: `可以添加：解析到 ${v || result.host || result.kind}${result.registry ? `（${result.registry}）` : ''}` };
  }
  const map = { 'already-installed': '已经安装', 'not-found': 'registry 上找不到', network: '网络不可达', 'invalid-spec': '规格无效', 'not-a-package': '不是 npm 包', 'not-a-bundle': '不是 DSH 组合包', unknown: '未知原因' };
  return { tone: result.problem === 'already-installed' ? 'ok' : 'warn', text: `${map[result.problem] ?? result.problem}：${result.reason}` };
}
