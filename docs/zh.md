# DSH Plugin Scout · 发现插件

[English](../README.md) | [中文](zh.md)

[![ci](https://github.com/fegnze/dsh-plugin-scout/actions/workflows/ci.yml/badge.svg)](https://github.com/fegnze/dsh-plugin-scout/actions/workflows/ci.yml) · MIT

在 DeepSeek Harness 里发现并核验 GitHub `topic:dsh-plugin` 上的插件：按用途分类、按可信度排序、套用官方的 peer 兼容规则。适用 DSH **0.2.x**（`>=0.2.0-rc.2 <0.3.0`），实测版本为桌面版 0.2.0-rc.2。

> 应用内界面目前仅有中文。官方插件页里的插件标题与描述已本地化（`locale/en.json`、`locale/zh.json`）。

## 安装

官方「插件」页 → 添加插件，填入以下任一规格：

| 规格 | 说明 |
| --- | --- |
| `dsh-plugin-scout` | 推荐。npm 预构建产物带 provenance，无安装脚本，不需要批准构建 |
| 若发布时提供预构建的 `dsh-plugin-scout-<版本>.tgz`，填它的绝对路径 | 不经 npm 注册表；当前 tag 工作流只创建发布说明，不附带 tarball |

命令行：`dsh plugin --profile <profile> add dsh-plugin-scout`。装好后在插件页启用，再打开「插件 → Scout」（Plugins → Scout）。中英文页签名称均为 **Scout**，不新增侧栏入口，官方「发现」页签保持不变。

不要用 `github:fegnze/dsh-plugin-scout` 安装：git 安装拿到的是源码，没有 `lib/`，本仓库也不提供 `prepare` 脚本。

## 原生「发现」索引

在官方「插件 → 发现 → 索引源」中添加：

```text
https://fegnze.github.io/dsh-plugin-scout/index.json
```

这是 format-1 插件目录，不是把 Scout 页面嵌入原生发现页；浏览目录不需要安装 Scout。GitHub Actions 每天 UTC 03:23（北京时间 11:23）及生成器变更时重建，只有通过官方 DSH 格式验证后才部署。生成失败保留上次部署。

公开目录仅包含去重后的 npm bundle：兼容目标 DSH 0.2.1-rc.2、仓库来源匹配、无安装钩子且声明 provenance。归档、有风险、仓库版本漂移、事实过期或不完整的条目不输出。fork 保留来源标签。provenance 存在不等于已完成密码学验证，也不是安全保证。每项锁定 npm 版本，发布时间来自 npm 的真实记录；最终安装仍由官方安装器判定。目标运行时只是目录发布策略，不表示兼容所有 DSH 版本。

执行 `GH_TOKEN=<只读令牌> node scripts/generate-market.mjs` 从公开 GitHub/npm 数据生成。`MARKET_OUTPUT`、`SCOUT_CACHE`、`DSH_TARGET` 分别覆盖输出、可丢弃抓取缓存、目标运行时。不公开本机 profile 或用户缓存；生成的 `site/index.json` 与抓取缓存被 Git 忽略，CI 只上传公开目录作为 Pages 产物。索引源由你显式添加，Scout 不自动修改来源配置。

## 一键安装，走官方安装器

抽屉里的「安装」与官方「添加插件」走同一条路径：先 `inspect` 预检，再 `installBundle(spec, {enabled:false, requestId, registry})`。插件**装好后默认不启用**，「启用」是单独一次点击（`setBundleEnabled`）。

- 有安装钩子或 peer 不覆盖当前版本的插件，「安装」要点两次才执行。
- 依赖的构建脚本被官方安装器拦下时（`pendingBuilds`），会逐个列出；双击「允许并重装」后才带 `approvedBuilds` 重装。
- 安装中可「取消安装」（`cancelInstall`，同一 `requestId`）；回复丢失时用 `waitForInstall` 取回结果。失败时官方安装器自动回滚 `package.json` 和锁文件。
- **卸载、版本豁免仍只在官方「插件」页做**：本插件不调用 `removeBundle`，测试中一调用就失败。没有官方 pluginManager 时不显示「安装」按钮，退回「复制锁定规格 + 去插件页添加」。

## 数据来源（只用一手来源）

| 来源 | 用途 |
| --- | --- |
| GitHub GraphQL `search(topic:dsh-plugin)` | 仓库元数据、根 `package.json`、`cordis.patch.yml` 的文本（不求值） |
| `registry.npmjs.org/<name>/latest` | 实际会被安装的清单：peer、安装钩子、`repository`、provenance |
| 官方 `pluginManager.listBundles` / `inspect` | 已安装状态；添加前的官方预检（只解析，不执行代码） |
| 官方 `pluginManager.installBundle` / `waitForInstall` / `cancelInstall` / `setBundleEnabled` | 一键安装（默认不启用）、取消、单独启用；进度来自 `plugin-manager/install-state` 与 `install-log` 事件 |

不使用任何第三方插件市场或聚合站。topic 搜索显式使用 `fork:true`，同时纳入原仓库与 fork；fork 保留来源提示并接受相同核验。从 0.1.5 或更早版本升级后，须执行一次「全量重建索引」，补齐旧搜索范围遗漏、近期未推送的 fork。

**抓取实测（2026-10）**：topic 下约有 1.9 万个仓库，其中 8 月集中出现 1.27 万个，大量是同名副本。GitHub 搜索单次查询最多返回 1000 条结果，所以按时间窗口自适应二分，每个窗口不超过 900 条，最小窗口 60 秒。每页 50 条：密集窗口里每页 100 条会返回 502，遇到 502 时依次降到 25、10，并从同一游标续翻。之后按 `pushed` 字段做增量抓取。

**刷新是流式、按变化量计费的**：
- **最新的先出。** 时间窗先按几何间隔播种（近 6 小时 / 1 天 / 3 天 / 1 周 / 1 月 / 3 月 / 更早），从最新一段开始翻。切窗计数与翻页并行跑（3 路）。
- **边抓边发布。** 每页结果立即并入记录集，每 1.5 秒发布一次，界面随 `status.rev` 变化重拉列表；刷新期间旧索引一直可用。每 30 秒落一次断点。
- **只为变化付费。** 已有索引时先走轻查询：只取元数据，每页 100 条，不读 blob。`pushedAt` 没变的仓库沿用已有事实，只刷新 star 等元数据；变动过的仓库才按 node id 每 50 个一批补取 `package.json` 和 patch。
- **npm 并行。** npm 查询与 GitHub 抓取同时进行（8 路）。只有仓库有新推送、npm 条目缺失或超过 1 天时才重查；即便本轮增量未命中仓库，超过 1 天的过期条目也按最旧优先补查，每轮最多 800 个。
- **激活不等索引。** 激活时不等待约 30 MB 的索引读完，界面先拿到 `loaded:false`，随后自行轮询。

实测（2026-10-14，真实网络）：

| 场景 | 首批可见 | 总耗时 | 说明 |
|---|---|---|---|
| 增量，1082 个仓库有推送 | 4.5 s | 38 s | 125 个补 blob，963 个只刷新元数据，70 次 npm 查询 |
| 冷启动全量 | 6.7 s | — | 60 s 内已可浏览约 1000 个插件，其余在后台补齐 |

刷新还会以有界、精确的只读查询补全 npm `repository` 指向的 GitHub 来源仓库。只有 GitHub 实际根清单中的包名一致时才纳入索引；不会因缺少 topic 就把无关同名仓库当成发布源，查询失败也不会伪造来源事实。

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

总分截断到 0–100。任何一项为 ✕ 都记为「有风险」：复制规格或安装都要点两次，徽章上带 ✕。同名的多个仓库会折叠到同一个代表仓库下，选择顺序是：来源链一致 > 分数 > stars > 创建最早；其余仓库记为副本，默认隐藏。

用途分类共 10 类：界面、会话、记忆、Agent、工具、模型、安全、开发、桥接、领域。分类依据是依赖的官方包（权重最高）、topics/keywords（3 分）和文本（2 分），总分不低于 2 才归类。在 41 个人工标注样本上，第一类命中率不低于 35/41。

## 界面与接缝

- **Scout 页签**：「插件 → Scout」，通过 `plugins.tab` 注册（`id: dsh-plugin-scout`、`order: 40`），内容包括搜索、筛选（兼容、风险、形态、安装状态、副本）、分类条、排序和分页。不新增侧栏入口或独立 `main` 面板；页面标题由官方插件页管理，Scout 不重复显示页面标题或副标题。Scout 适配窗口剩余高度，分类与排序下方的插件结果独立滚动；左侧筛选超出高度时也单独滚动，滚动到边界不会继续带动整页。官方「发现」页签保持不变。
- **详情抽屉**：核验清单、评分构成、分类依据、来源链与副本、作用面（cordis 插入、`client.inject`、peer），以及官方预检。底部按钮：
  - **安装 / 启用 / 取消安装**：见上文。
  - **复制锁定规格**：复制 `name@npmVersion`；未发布的复制 `github:owner/repo`。
  - **在插件页打开 / 去插件页添加**：已安装的通过官方页签所有者传入的 `openPackage` 回调直达详情；回调不可用或尚未安装时，通过 `layout.selectPanel('plugins')` 切到官方插件页。
- **官方插件页**：`plugins.detail.badge`（可信度分数）、`plugins.detail.section`（核验清单）。官方详情不提供跳转 Scout 的链接：目前没有选择扩展页签的公开 API（`pluginNavigation` 只有 `openBundle`）。索引里没有的包返回 `null`，不占位。

## 开发

```sh
npm install --ignore-scripts
npm test          # 先构建 lib/，再跑 core / host / client / manifest 四组测试
```

本地调试：在插件页添加本目录的绝对路径（link 安装，源目录不能移动）。Host 侧有改动时需要完整重启 App；只改了 Client 时刷新窗口即可。

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
- `src/client/`：发现页、抽屉、安装器、官方页徽章/区块、样式。
- `scripts/build.mjs`：esbuild 打包，打包后**实际执行**两份产物来把关。
- `test/`：`core`（真实 GraphQL 页、41 个标注样本）、`host`（假 fetch 端到端刷新、路由鉴权）、`client`（Happy DOM 加载构建产物）、`manifest`（官方发布约定）。

升级 DSH 后，先核对官方插件页的 Slot 名、`pluginManager` 方法和 `dsh-app-boot` 导出，再重新验收。

## 对齐的官方约定

依据官方仓库的 `docs/user/develop/basic/publish`、`docs/cookbook/adding-a-package` §5 和 `@deepseek-ai/dsh-package-manifest` 类型；`test/manifest.test.mjs` 逐条断言。

| 约定 | 本包 |
| --- | --- |
| 组合包：`dsh.bundle.patch`，patch 行按**包名**引用 | `./cordis.patch.yml` → `name: 'dsh-plugin-scout'` |
| `dsh` 下只放公共作者字段 | `manifestVersion: 1`、`bundle`、`client`（`platform: web`） |
| 展示元信息：`locale/en.json` 为入口，其他语言同字段；导出 `./locale/*.json`、`./package.json` 并发布 | `en.json` / `zh.json` 的 `meta.title`、`meta.description` |
| 图标：包内相对路径，≤256 KiB，自包含 | `./icon.svg` |
| 需要与宿主共享实例的包写进 peer；版本门禁只看 `@deepseek-ai/dsh*` peer | `@deepseek-ai/cordis ~4.0.4`；`@deepseek-ai/dsh-app-boot >=0.2.0-rc.2 <0.3.0`（optional，作为官方门禁的版本声明） |
| `engines.dsh` 只是声明 | `>=0.2.0-rc.2 <0.3.0` |
| 发预构建产物，不让用户批准构建 | npm `--provenance` 发布，无 `prepare` 及其他安装钩子 |

## 发布

1. 在 `package.json` 中准备目标 `version`，将发布改动提交到 `main`。
2. 从 `main` 手动触发 `publish.yml`，`expected_sha` 填已批准的完整提交 SHA。先保留默认 `dry_run: true` 做验证：工作流核对 SHA、不执行生命周期脚本地安装依赖、运行测试（含构建），并用 `npm pack --dry-run --ignore-scripts` 预览包。dry-run 不发布。正式发布获批准后，以同一个 SHA 和 `dry_run: false` 再触发，执行 `npm publish --access public --provenance --ignore-scripts`。
3. npm 通过可信发布（Trusted Publishing，OIDC）认证，仓库里不存 npm token，provenance 自动附带。在 npmjs.com → 包 Settings → Trusted Publisher 配置本 GitHub 仓库与工作流 `publish.yml`，或执行 `npx npm@latest trust github dsh-plugin-scout --file publish.yml --repo fegnze/dsh-plugin-scout`。
4. 独立的 `git tag v<version> && git push origin v<version>` 触发 `release.yml`：只核对 tag 与包版本一致并创建带自动生成说明的 GitHub Release，不发布 npm，也不构建或附带 tgz。如果提供 tarball 安装，需要另行提供预构建归档。
5. 仓库保持 public，并带 topic `dsh-plugin`，这样才会出现在 https://github.com/topics/dsh-plugin，也能被 Scout 自己收录。
