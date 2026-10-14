import React, { useEffect, useState } from 'react';
import { api } from './api.js';
import { ICON, ago, inspectText } from './view.js';

export function Checklist({ checks }) {
  return (
    <div className="scx-chk">
      {checks.map((c) => (
        <div className="scx-ci" key={c.id} data-check={c.id} data-st={c.st}>
          <div className="scx-ic" data-st={c.st}>{ICON[c.st]}</div>
          <div><div><span className="scx-id">{c.id}</span>{c.text}</div><div className="scx-ev">{c.ev}</div></div>
        </div>
      ))}
    </div>
  );
}

export function Drawer({ repoKey, face, labels, runtime, installed, onClose, say }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [inspect, setInspect] = useState(null);
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    let live = true;
    setD(null); setErr(null); setInspect(null); setArmed(false);
    api.detail(repoKey).then((v) => { if (live) setD(v); }, (e) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, [repoKey]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const runInspect = async () => {
    if (!d || !face.inspect) return;
    setInspect({ pending: true });
    setInspect(await face.inspect(d.spec));
  };

  const copy = async () => {
    if (d.risky && !armed) { setArmed(true); say('存在 ✕ 级核验项，先看清单；再点一次确认复制'); return; }
    setArmed(false);
    try { await navigator.clipboard.writeText(d.spec); say(`已复制 ${d.spec}`); } catch { say('剪贴板不可用，请手动选中规格复制'); }
  };

  const open = () => {
    const how = face.openPlugins(installed.has(d?.name) ? d.name : undefined);
    say(how === 'bundle' ? '已打开官方插件页中的这个插件' : how === 'panel' ? '已切到官方「插件」页 · 点「添加插件」粘贴规格' : '找不到官方插件页入口');
  };

  const it = inspectText(inspect && !inspect.pending ? inspect : null);
  return (
    <>
      <div className="scx-scrim" onClick={onClose} />
      <aside className="scx-sheet scx-root" aria-label="插件详情" data-scout-drawer="">
        <div className="scx-dh">
          <h2>{d?.name ?? repoKey}</h2>
          <button type="button" className="scx-x" aria-label="关闭" onClick={onClose}>×</button>
          <div className="scx-pkg"><a href={`https://github.com/${d?.repo ?? repoKey}`} target="_blank" rel="noreferrer">github.com/{d?.repo ?? repoKey}</a> · {d?.license ?? '无许可证'}{d ? ` · ★ ${d.stars} · 推送于 ${ago(d.pushedAt)}` : ''}</div>
        </div>
        <div className="scx-dbody">
          {err ? <div className="scx-note" data-tone="bad">{err}</div> : null}
          {!d && !err ? <div className="scx-empty">加载中…</div> : null}
          {d ? (
            <>
              {d.description ? <p style={{ color: 'var(--scx-ink2)', margin: '12px 0 0' }}>{d.description}</p> : null}
              <div className="scx-sec">
                <h3>核验清单 · 可信度 {d.score}</h3>
                <Checklist checks={d.checks} />
              </div>
              <div className="scx-sec">
                <h3>评分构成</h3>
                <div className="scx-parts">
                  {d.scoreParts.map(([k, n]) => <React.Fragment key={k}><span>{k}</span><span>{n > 0 ? '+' : ''}{n}</span></React.Fragment>)}
                  <b>可信度</b><b>{d.score}</b>
                </div>
              </div>
              <div className="scx-sec">
                <h3>用途分类</h3>
                {d.cats.length ? d.cats.map((c, i) => (
                  <div className="scx-catev" key={c.id}>
                    <div><span className="scx-tag" data-tone={i ? 'cat2' : 'cat'}>{labels[c.id] ?? c.id}</span>{i ? null : <span style={{ fontSize: 11, color: 'var(--scx-ink3)' }}>主类</span>}<span className="scx-s">得分 {c.score}</span></div>
                    <ul>{c.evidence.map((e) => <li key={e}>{e}</li>)}</ul>
                  </div>
                )) : <span style={{ color: 'var(--scx-ink3)' }}>没有足够信号，归入「未归类」。</span>}
              </div>
              <div className="scx-sec">
                <h3>来源链</h3>
                <div className="scx-chain">
                  <span className="scx-node">github.com/{d.repo}</span><span>→</span>
                  {d.npmVersion
                    ? <><span className="scx-node">npm {d.name}@{d.npmVersion}</span><span>→</span><span className="scx-node" style={{ color: d.provenance ? 'var(--scx-ok)' : 'var(--scx-ink4)' }}>{d.provenance ? 'provenance ✓' : '无 provenance'}</span></>
                    : <span className="scx-node" style={{ color: 'var(--scx-warn)' }}>{d.chain === 'unknown' ? 'npm 未查询' : '未发布 npm'}</span>}
                </div>
                {d.copiesList.length ? <div className="scx-ev" style={{ marginTop: 6 }}>同名仓库 {d.copiesList.length} 个：{d.copiesList.slice(0, 5).map((c) => c.repo).join('、')}{d.copiesList.length > 5 ? ' …' : ''}</div> : null}
              </div>
              <div className="scx-sec">
                <h3>作用面</h3>
                <dl className="scx-kv">
                  <dt>形态</dt><dd>{d.kinds.join(' + ')}</dd>
                  <dt>cordis 插入</dt><dd>{d.inserts.length ? d.inserts.map((n) => <div className="scx-mono" key={n}>{n}</div>) : <span style={{ color: 'var(--scx-ink3)' }}>仓库无 cordis.patch.yml 或未声明</span>}</dd>
                  <dt>client.inject</dt><dd>{d.clientInject.length ? d.clientInject.map((m) => <div className="scx-mono" key={m}>{m}</div>) : <span style={{ color: 'var(--scx-ink3)' }}>无</span>}</dd>
                  <dt>DSH peer</dt><dd className="scx-mono">{Object.entries(d.compatPeers).map(([k, v]) => `${k}@${v}`).join(', ') || '无'}</dd>
                  <dt>运行时依赖</dt><dd>{d.depCount} 个</dd>
                </dl>
              </div>
              <div className="scx-sec">
                <h3>官方预检（pluginManager.inspect，不执行代码）</h3>
                {!face.inspect ? <span style={{ color: 'var(--scx-ink3)' }}>当前窗口拿不到官方插件管理服务</span>
                  : inspect?.pending ? <span style={{ color: 'var(--scx-ink3)' }}>查询中…</span>
                    : it ? <div className="scx-note" data-tone={it.tone === 'bad' ? 'bad' : undefined} style={{ color: it.tone === 'ok' ? 'var(--scx-ok)' : undefined }}>{it.text}</div>
                      : <button type="button" className="scx-btn" onClick={runInspect}>预检 {d.spec}</button>}
                <div className="scx-ev" style={{ marginTop: 6 }}>兼容性由官方安装器在 pnpm 运行前按 peer 规则再判一次；不兼容会被拒装，可在官方页按版本豁免。</div>
              </div>
            </>
          ) : null}
        </div>
        {d ? (
          <div className="scx-df">
            <div className="scx-spec" title={d.spec}>{d.spec}</div>
            <button type="button" className="scx-btn" data-tone={d.risky ? 'bad' : undefined} onClick={copy}>{d.risky ? (armed ? '再点一次确认复制' : '了解风险后复制') : '复制锁定规格'}</button>
            <button type="button" className="scx-btn" data-tone="pri" onClick={open}>{installed.has(d.name) ? '在插件页打开' : '去插件页添加'}</button>
          </div>
        ) : null}
      </aside>
    </>
  );
}
