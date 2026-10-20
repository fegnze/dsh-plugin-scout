import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';
import { ago, band, progressRatio, progressText, rowTags } from './view.js';
import { Drawer } from './Drawer.jsx';

const FLAGS = [
  ['nohook', '无安装脚本'], ['chain', '来源链吻合'], ['prov', '有 provenance'], ['norisk', '无 ✕ 项'], ['active', '30 天内活跃'],
];
const KINDS = [['client', '带界面'], ['hostonly', '仅宿主']];
const COMPAT = [['ok', '兼容当前版本'], ['incompatible', '不兼容'], ['none', '未声明']];
const PAGE = 60;

export function ScoutPage({ face }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('all');
  const [sort, setSort] = useState('score');
  const [compat, setCompat] = useState([]);
  const [flags, setFlags] = useState([]);
  const [inst, setInst] = useState('all');
  const [limit, setLimit] = useState(PAGE);
  const [data, setData] = useState(null);
  const [sel, setSel] = useState(null);
  const [toast, setToast] = useState(null);
  const installed = face.useInstalled();
  const seq = useRef(0);

  const say = useCallback((text) => { setToast(text); clearTimeout(say.h); say.h = setTimeout(() => setToast(null), 2200); }, []);

  const loadStatus = useCallback(async () => {
    try { setStatus(await api.status()); setError(null); } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { void loadStatus(); }, [loadStatus]);
  // 索引后台加载中或刷新进行中轮询状态；status.rev 每次发布都会变，列表随之重拉（边抓边看）。
  const busy = !!status && (status.running || !status.loaded);
  useEffect(() => {
    if (!busy) return undefined;
    const h = setInterval(loadStatus, 1500);
    return () => clearInterval(h);
  }, [busy, loadStatus]);

  const installedKey = installed.join('\n');
  useEffect(() => {
    const id = ++seq.current;
    const h = setTimeout(async () => {
      try {
        const v = await api.list({ q, cat, sort, compat, flags, inst, installed, limit });
        if (id === seq.current) { setData(v); setError(null); }
      } catch (e) { if (id === seq.current) setError(e.message); }
    }, q ? 180 : 0);
    return () => clearTimeout(h);
  }, [q, cat, sort, compat.join(), flags.join(), inst, installedKey, limit, status?.rev]);

  const toggle = (list, set, v) => { set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]); setLimit(PAGE); };
  const labels = status?.categories ?? {};
  const facets = status?.facets;
  const instSet = useMemo(() => new Set(installed), [installedKey]);

  const refresh = async (full) => {
    try { setStatus(await api.refresh(full)); } catch (e) { say(e.message); void loadStatus(); }
  };

  const empty = status && status.loaded && !status.crawledAt && !status.running && !status.repos;
  return (
    <div className="scx-root scx-page" data-scout-page="">
      <div className="scx-top">
        <div className="scx-search">
          <span aria-hidden="true">⌕</span>
          <input aria-label="搜索插件" placeholder="名称、描述、仓库、分类" value={q} onChange={(e) => { setQ(e.target.value); setLimit(PAGE); }} />
        </div>
        <div className="scx-fresh">
          <span title={status?.runtimeSource}>运行时 {status?.runtime ?? '…'}</span>
          <span>{status?.running ? progressText(status.progress) : status && !status.loaded ? '读取索引…' : `更新于 ${ago(status?.crawledAt)}`}</span>
          <button type="button" className="scx-btn" disabled={!status || status.running} onClick={() => refresh(false)}>{status?.running ? '刷新中…' : '刷新'}</button>
        </div>
      </div>
      {status?.running ? <div className="scx-progress" style={{ margin: '0 16px' }}><i style={{ width: `${Math.round(progressRatio(status.progress) * 100)}%` }} /></div> : null}
      <div className="scx-body">
        <div className="scx-filters">
          <div className="scx-fg">
            <h4>兼容（官方 peer 规则）</h4>
            {COMPAT.map(([v, l]) => <label key={v}><input type="checkbox" checked={compat.includes(v)} onChange={() => toggle(compat, setCompat, v)} />{l}<span className="scx-n">{facets?.compat[v] ?? ''}</span></label>)}
          </div>
          <div className="scx-fg">
            <h4>风险与来源</h4>
            {FLAGS.map(([v, l]) => <label key={v}><input type="checkbox" checked={flags.includes(v)} onChange={() => toggle(flags, setFlags, v)} />{l}<span className="scx-n">{facets?.flags[v] ?? ''}</span></label>)}
          </div>
          <div className="scx-fg">
            <h4>形态</h4>
            {KINDS.map(([v, l]) => <label key={v}><input type="checkbox" checked={flags.includes(v)} onChange={() => toggle(flags, setFlags, v)} />{l}<span className="scx-n">{facets?.flags[v] ?? ''}</span></label>)}
          </div>
          <div className="scx-fg">
            <h4>本机</h4>
            {[['all', '全部'], ['hide', '隐藏已安装'], ['only', '只看已安装']].map(([v, l]) => <label key={v}><input type="radio" name="scx-inst" checked={inst === v} onChange={() => { setInst(v); setLimit(PAGE); }} />{l}</label>)}
          </div>
          <div className="scx-fg">
            <h4>同名副本</h4>
            <label><input type="checkbox" checked={flags.includes('copies')} onChange={() => toggle(flags, setFlags, 'copies')} />显示副本<span className="scx-n">{facets?.copies ?? ''}</span></label>
          </div>
          <div className="scx-fg">
            <button type="button" className="scx-btn" disabled={!status || status.running} onClick={() => refresh(true)}>全量重建索引</button>
          </div>
        </div>
        <div className="scx-list">
          {error ? <div className="scx-note" data-tone="bad">{error}</div> : null}
          {status?.error ? <div className="scx-note" data-tone="bad">上次刷新失败：{status.error.message}</div> : null}
          {empty ? <div className="scx-note">还没有索引。抓取边进行边出结果——最近活跃的插件几秒内就会出现，其余在后台补齐，期间可正常使用 DSH。<button type="button" className="scx-btn" style={{ marginLeft: 8 }} onClick={() => refresh(true)}>开始抓取</button></div> : null}
          <div className="scx-cats" role="tablist" aria-label="用途分类">
            {['all', ...Object.keys(labels), 'other'].filter((id) => id !== 'other' || (data?.cats.other ?? 0) > 0 || cat === 'other').map((id) => (
              <button key={id} type="button" role="tab" className="scx-cat" aria-selected={cat === id} onClick={() => { setCat(id); setLimit(PAGE); }}>
                {id === 'all' ? '全部' : id === 'other' ? '未归类' : labels[id]}<span className="scx-n">{data?.cats[id] ?? ''}</span>
              </button>
            ))}
          </div>
          <div className="scx-lhead">
            <span>{data ? `${data.total.toLocaleString()} 个插件${status?.running ? '（抓取中，持续增加）' : ''}` : '加载中…'}</span>
            <span style={{ marginLeft: 'auto' }}>排序</span>
            <select aria-label="排序" value={sort} onChange={(e) => setSort(e.target.value)}>
              <option value="score">可信度</option><option value="stars">star</option><option value="recent">最近推送</option><option value="name">名称</option>
            </select>
          </div>
          {data && !data.rows.length && !empty ? <div className="scx-empty">没有符合条件的插件。放宽左侧筛选，或换个关键词。</div> : null}
          {data?.rows.map((r) => (
            <button type="button" key={r.repo} className="scx-item" aria-current={sel === r.repo} data-repo={r.repo} onClick={() => setSel(r.repo)}>
              <div className="scx-score" data-band={band(r.score)} title={r.scoreParts.map(([k, n]) => `${k} ${n > 0 ? '+' : ''}${n}`).join('\n')}>{r.score}</div>
              <div style={{ minWidth: 0 }}>
                <div className="scx-rt"><b>{r.name}</b><span className="scx-ver">{r.npmVersion ?? r.repoVersion ?? ''}</span></div>
                <div className="scx-rd">{r.description || '（无描述）'}</div>
                <div className="scx-tags">{rowTags(r, labels, status?.runtime, instSet.has(r.name)).map(([tone, text], i) => <span key={i} className="scx-tag" data-tone={tone}>{text}</span>)}</div>
              </div>
              <div className="scx-meta"><div>★ {r.stars.toLocaleString()}</div><div>{r.repo.split('/')[0]}</div><div>{ago(r.pushedAt)}</div></div>
            </button>
          ))}
          {data && data.rows.length < data.total ? <div className="scx-more"><button type="button" className="scx-btn" onClick={() => setLimit(limit + PAGE)}>再显示 {Math.min(PAGE, data.total - data.rows.length)} 个</button></div> : null}
        </div>
      </div>
      {sel ? <Drawer repoKey={sel} face={face} labels={labels} runtime={status?.runtime} installed={instSet} onClose={() => setSel(null)} say={say} /> : null}
      {toast ? <div className="scx-toast" role="status">{toast}</div> : null}
    </div>
  );
}
