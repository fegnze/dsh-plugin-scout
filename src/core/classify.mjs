// 用途分类：纯规则、可解释。移植自 Plan/dsh-plugin-scout/proto/classify.py（v2，41 例人工标注 35 命中）。
// 信号强度：官方包依赖 > 仓库 topics / npm keywords（3 分）> 名称与描述（2 分）。阈值 2，可多类，主类 = 最高分。

export const CATEGORIES = {
  ui:      { label: '界面与主题',   deps: { 'dsh-client-ui-theme': 4, 'dsh-brand': 3 }, words: ['theme', 'skin', '皮肤', '主题', '界面', 'workbench', '工作台', '分栏', 'tui', 'terminal ui'] },
  session: { label: '会话管理',     deps: { 'dsh-api-session-controller': 3, 'dsh-session-projection': 2 }, words: ['session', '会话', 'export', '导出', 'archive', '归档', '分支', 'rename', '重命名', '旁问', 'side-ask'] },
  memory:  { label: '记忆与上下文', deps: {}, words: ['memory', '记忆', 'context', '上下文', 'compress', 'compression', '压缩', 'knowledge', '知识', 'recall', 'observational', 'evolve', 'evolution', 'self-improving', 'soul', 'personalization', 'fatigue', '疲劳'] },
  agent:   { label: '智能体与编排', deps: { 'dsh-subagent': 3, 'dsh-agent-loop': 2, 'dsh-agent-preset': 3 }, words: ['agent-preset', 'subagent', 'multi-agent', 'orchestration', '编排', '多代理', 'director', 'yolo', 'auto-approval'] },
  tools:   { label: '工具与 MCP',   deps: { 'dsh-mcp-client': 4, 'dsh-skill': 2 }, words: ['mcp', 'skill', 'skills', 'stdio', '工具'] },
  model:   { label: '模型与用量',   deps: {}, words: ['provider', 'ollama', 'usage', '用量', 'cost', '计费', 'token', 'eval', 'evaluation'] },
  safety:  { label: '安全与合规',   deps: { 'dsh-sandbox-policy': 3 }, words: ['security', 'guard', 'compliance', 'privacy', 'pipl', '合规', '个保法', '数据安全法', '分类分级', '未成年人'] },
  dev:     { label: '编码与开发',   deps: {}, words: ['code-review', 'coding-agent', 'git', 'github', 'vscode', 'codex', 'claude-code', '代码评审', 'monaco', 'blueprint'] },
  bridge:  { label: '外部集成',     deps: {}, words: ['mobile', '手机', 'wechat', '微信', 'onebot', 'qq', 'siyuan', '思源', 'notify', 'notification', '通知', 'ssh', 'windows', 'relay', 'bridge', 'inbox'] },
  domain:  { label: '领域应用',     deps: {}, words: ['a股', '看盘', 'stock', 'mathematics', '数学', 'finance', 'html'] },
};

const CJK = /[\u4e00-\u9fff]/;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const patterns = new Map();

/** ASCII 词按词边界匹配（避免 `git` 命中 `digital`），含中文的词按子串匹配。 */
export function has(word, text) {
  if (CJK.test(word)) return text.includes(word);
  let re = patterns.get(word);
  if (!re) patterns.set(word, re = new RegExp(`(?<![a-z0-9])${escape(word)}(?![a-z0-9])`));
  return re.test(text);
}

/**
 * @param {{name:string, description?:string, topics?:string[], keywords?:string[], dshDeps?:string[], clientInject?:string[]}} x
 * @returns {{id:string, score:number, evidence:string[]}[]} 按得分降序；空数组 = 未归类
 */
export function classify(x) {
  const deps = new Set([...(x.dshDeps ?? []), ...(x.clientInject ?? [])].map((d) => String(d).split('/').pop()));
  const tags = [...(x.topics ?? []), ...(x.keywords ?? [])].map((t) => String(t).toLowerCase()).join(' | ');
  const text = `${String(x.name ?? '').replace(/-/g, ' ')} ${x.description ?? ''}`.toLowerCase();
  const out = [];
  for (const [id, cat] of Object.entries(CATEGORIES)) {
    let score = 0;
    const evidence = [];
    for (const [dep, weight] of Object.entries(cat.deps)) {
      if (deps.has(dep)) { score += weight; evidence.push(`依赖 @deepseek-ai/${dep}`); }
    }
    for (const word of cat.words) {
      if (has(word, tags)) { score += 3; evidence.push(`标签 ${word}`); }
      else if (has(word, text)) { score += 2; evidence.push(`名称/描述含「${word}」`); }
    }
    if (score >= 2) out.push({ id, score, evidence: evidence.slice(0, 3) });
  }
  return out.sort((a, b) => b.score - a.score);
}
