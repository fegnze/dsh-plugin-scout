# DSH Plugin Scout · 发现插件

在 DeepSeek Harness 里发现并核验 GitHub `topic:dsh-plugin` 上的插件：按用途分类、按可信度排序、套用官方的 peer 兼容规则。目标桌面版本为 **0.2.0-rc.2**。

**只核验，不安装。** 安装、卸载、启用和版本豁免都交给官方「插件」页。本插件不调用 `install` / `removeBundle` / `setBundleEnabled`，测试中这三者一被调用就会失败。

## 数据来源（只用一手来源）

| 来源 | 用途 |
| --- | --- |
| GitHub GraphQL `search(topic:dsh-plugin)` | 仓库元数据、根 `package.json`、`cordis.patch.yml` 的文本（不求值） |
| `registry.npmjs.org/<name>/latest` | 实际会被安装的清单：peer、安装钩子、`repository`、provenance |
| 官方 `pluginManager.listBundles` / `inspect` | 已安装状态；添加前的官方预检（只解析，不执行代码） |

不使用任何第三方插件市场或聚合站。

**抓取实测（2026-10）**：topic 下约有 1.9 万个仓库，其中 8 月集中出现 1.27 万个，大量是同名副本。GitHub 搜索单次查询最多返回 1000 条结果，所以按时间窗口自适应二分，每个窗口不超过 900 条，最小窗口 60 秒。每页 50 条：密集窗口里每页 100 条会返回 502，遇到 502 时依次降到 25、10，并从同一游标续翻。首次全量抓取需要几分钟，之后按 `pushed` 字段做增量抓取。

## 核验项与可信度

| 项 | 判定 | 分值 |
| --- | --- | --- |
| V1 | 根 `package.json` 声明 `dsh.bundle` / `dsh.client`（不满足的不算插件） | 20 |
| V2 | 官方 peer 规则：只看 `@deepseek-ai/dsh` 和 `@deepseek-ai/dsh-*`，`semver.satisfies(runtime, range, {includePrerelease})`，`workspace:*` 视为当前版本。在 App 内直接调用 `dsh-app-boot.evaluatePluginCompatibility` | 覆盖 30 · 无 peer 10 · 不覆盖 5 |
| V3 | 安装钩子：preinstall / install / postinstall / prepare | 无 +15 · 有 −15 |
| V4 | 来源链：npm 同名包的 `repository` 指回本仓库 | 一致 +15 · 不一致 −20 · 未发布 0 |
| V5 | npm provenance | +10 |
| V6 | 活跃度：归档、90 天内推送、版本漂移（V6b） | +5 / −10 |
| V9 | 用了 `@deepseek-ai/` 作用域，但仓库不属于 deepseek-ai | −30 |
| V10 | fork | 仅提示 |
| — | stars：`min(5, round(log10(1+s)·2))` | ≤5 |

总分截断到 0–100。任何一项为 ✕ 都记为「有风险」：复制规格要点两次，徽章上带 ✕。同名的多个仓库会折叠到同一个代表仓库下，选择顺序是：来源链一致 > 分数 > stars > 创建最早；其余仓库记为副本，默认隐藏。

用途分类共 10 类：界面、会话、记忆、Agent、工具、模型、安全、开发、桥接、领域。分类依据是依赖的官方包（权重最高）、topics/keywords（3 分）和文本（2 分），总分不低于 2 才归类。在 41 个人工标注样本上，第一类命中率不低于 35/41。

## 界面与接缝

- **发现页**：侧栏「发现插件」→ `main` 面板，内容包括搜索、筛选（兼容、风险、形态、安装状态、副本）、分类条、排序和分页。
- **详情抽屉**：核验清单、评分构成、分类依据、来源链与副本、作用面（cordis 插入、`client.inject`、peer），以及官方预检。底部按钮：
  - **复制锁定规格**：复制 `name@npmVersion`；未发布的复制 `github:owner/repo`。
  - **在插件页打开 / 去插件页添加**：已安装的通过官方 `pluginNavigation.openBundle` 直达详情；未安装的切到官方插件页，粘贴规格即可添加。
- **官方插件页**：`plugins.detail.badge`（可信度分数）、`plugins.detail.section`（核验清单，以及「在发现页查看 →」）。索引里没有的包返回 `null`，不占位。

## 安装

```sh
npm install --ignore-scripts
npm test          # 先构建 lib/，再跑 core / host / client 三组测试
```

在 **desktop profile** 的插件页添加本目录的绝对路径（link 安装，源目录不能移动）。Host 侧有改动时需要完整重启 App；只改了 Client 时刷新窗口即可。

**GitHub token** 依次从这些地方取：环境变量 `DSH_SCOUT_GITHUB_TOKEN` / `GITHUB_TOKEN` / `GH_TOKEN`，或通过 DSH subprocess 服务执行 `gh auth token`。token 只在本进程内存里使用，不落盘、不回传给前端。没有 token 时页面会提示执行 `gh auth login`。

## 数据与配置

- 索引：`~/.dsh/dsh-plugin-scout/index.json`，只存事实（仓库元数据、精简清单、npm 缓存），每次加载按当前运行时重新判定。所以升级 DSH 后，兼容结论会自动更新。
- 自动刷新：App 运行期间由进程内定时器执行，启动 45 秒后检查一次，超过 `autoRefreshHours`（默认 24，设为 0 关闭）就做增量抓取。不使用 LaunchAgent 或外部调度器。
- 可选配置：`dataDir`、`topic`、`runtimeVersion`（覆盖运行时探测）、`autoRefreshHours`。

## 安全边界

- 接口挂在 DSH 自己的 webServer 上（`/dsh-plugin-scout/api/*`）。每个请求都要带自定义头 `x-dsh-plugin-scout: 1`，并通过 DSH `connection.admit`（Host/Origin 栅栏 + 浏览器认证）。拿不到 `connection` 服务时拒绝请求（fail closed）。
- `cordis.patch.yml` 只用正则提取 `name:`，从不解析 YAML 标签。抓取到的代码不执行，也不下载 tarball。
- 样式标签在插入 DOM 之前就打上 `data-plugin` / `data-plugin-css`。只使用 `--dsw-alias-*` 令牌；类名避开宿主皮肤会匹配的子串；抽屉不用 `role="dialog"`。

## 结构

- `src/core/`：`classify.mjs`（用途分类）、`verify.mjs`（核验与评分）、`crawl.mjs`（GraphQL、切窗、npm）、`store.mjs`（事实索引、查询）。
- `src/host.mjs`：运行时与 token 探测、刷新状态机、同源路由、进程内定时。
- `src/client/`：发现页、抽屉、官方页徽章/区块、样式。
- `scripts/build.mjs`：esbuild 打包，打包后**实际执行**两份产物来把关。
- `test/`：`core`（真实 GraphQL 页、41 个标注样本）、`host`（假 fetch 端到端刷新、路由鉴权）、`client`（Happy DOM 加载构建产物）。

升级 DSH 后，先核对官方插件页的 Slot 名、`pluginManager` 方法和 `dsh-app-boot` 导出，再重新验收。
