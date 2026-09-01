# AGV 3D 实时监控大屏实施进度

状态日期：2026-09-01

任务书版本：`TASKS.md` v2.1

规格版本：`SPEC-20260901-agv-3d-monitor` v1.4

## 1. 当前执行状态

| 字段 | 当前值 |
|---|---|
| 项目状态 | `IN_PROGRESS` |
| 当前 Task | `TASK-003 统一坐标、地图校验与不可变 MapModel` |
| 当前 Task 状态 | `TODO` |
| 已完成工程 Task | `2 / 21` |
| 条件任务 | `TASK-021 WAITING_EXTERNAL` |
| 验收 Gate | GATE-001、GATE-002、GATE-003 均为 `NOT_READY` |
| 当前下一步 | 将 TASK-003 改为 `IN_PROGRESS` 后，实现 `shared/spatial`、地图校验与不可变 MapModel、`loadMap` 及 app 地图启动接线 |
| 项目完成条件 | TASK-001～TASK-021 全部 `DONE`，GATE-001～GATE-003 全部通过，SPEC A1～F6 均有当前证据 |

编号是推荐交付顺序，执行前必须核对真实依赖。`WAITING_EXTERNAL` 的 TASK-021 不阻塞 TASK-018～020；其他 Task 只有在自身依赖全部 `DONE` 后才能开始。

## 2. 当前仓库状态

### 2.1 Git 与工作区

| 项目 | 当前值 |
|---|---|
| 工作区 | `C:\code\agv-map-3d` |
| 分支 | `rxx`，跟踪 `origin/rxx`，与远端一致 |
| HEAD | `e350b47`（TASK-001 及文档更新已提交） |
| 未提交差异 | TASK-002 实施（当前变更）：新增 `src/app/bootstrap/**`（配置加载、启动编排及共置测试）、`src/shared/validation/**`、`src/shared/diagnostics/**`、`public/config.json`、`scripts/copyStaticAssets.mjs`、`scripts/verifyDist.mjs`、`scripts/smokeDist.mjs`；修改 `PROGRESS.md`、`package.json`（build 链接入资源复制与校验，新增 `verify:dist`、`smoke:dist`）、`src/main.tsx`（接入 `bootstrapApplication`）、`vite.config.ts`（`base: './'` 与开发服务器 `/json` 显式映射） |
| 用户输入 | `docs/SPEC_20260901_agv-3d-monitor.md`、原型图、`json/map.json`、`json/vehicle.json` 无差异 |

所有未提交差异均必须保留。每个 Task 开始和结束时以实际 `git status --short --branch` 为准，并直接更新本节当前值；不得恢复旧状态或把差异写成历史日志。

### 2.2 当前实现

- 应用骨架可启动、可构建：`src/main.tsx` 以 StrictMode 挂载 `src/app/App.tsx`；App 只装配唯一 `100vw × 100dvh` 的 R3F Canvas，场景内为 `src/app/scene/AgvMonitorScene.tsx` 组合锚点（无业务 3D 对象）。
- TASK-002 已完成运行时配置与部署基线：
  - `src/app/bootstrap/loadRuntimeConfig.ts`：以 `document.baseURI`（可注入 baseUrl）解析 `config.json`，`no-cache` 读取后经 `validateRuntimeConfig` 严格白名单校验（dataSource/mapUrl/wsUrl/maxVehicles/staleAfterMs/renderer/coordinateTransform，未知字段即拒绝，配置深度冻结）；网络/HTTP/JSON/字段/WS 策略失败分别抛出 `CONFIG_FETCH_FAILED`/`CONFIG_HTTP_STATUS`/`CONFIG_JSON_PARSE`/`CONFIG_FIELD`/`CONFIG_UNKNOWN_FIELD`/`CONFIG_WS_REQUIRED`/`CONFIG_WS_INSECURE` 稳定错误码；HTTPS 页面禁止明文 `ws:`，允许 `wss:` 与同源 https 代理。
  - `src/app/bootstrap/bootstrapApplication.ts`：启动阶段编排；支持 AbortSignal 与重复启动取消（新启动中止旧流程，取消不进错误诊断）；`config` 阶段耗时以 `BOOTSTRAP_STAGE_DURATION` 写入诊断通道；失败以稳定错误码上报恰好一次后原样重抛。`src/main.tsx` 已接入，配置失败保持唯一清屏 Canvas，不渲染错误 DOM。
  - `src/shared/diagnostics`：结构化诊断通道（稳定代码、级别、上下文、单调时间、可注入 sink、同码采样合并、sink 异常隔离）与 `StructuredError`/`isAbortError`。
  - `src/shared/validation`：`isFiniteNumber`、`isPlainObject` 业务无关校验原语。
  - 部署链：`vite.config.ts` `base: './'` 使同一 dist 支持根/子路径；开发服务器显式把 `/json/map.json`、`/json/vehicle.json` 映射到仓库 `json/`；`build = tsc -b && vite build && copyStaticAssets && verifyDist`；`verify:dist` 校验 `dist/index.html`、`dist/config.json`、`dist/json/map.json`、相对路径引用与凭据字段；`smoke:dist` 以 HTTP 冒烟根路径、`/monitor/` 子路径与 `/broken/`（模拟 config 500）三种挂载。
- 工具链齐备：`@/ -> src/` 别名在 `tsconfig.app.json`、`vite.config.ts`、`vitest.config.ts` 三处一致；脚本含 `lint/typecheck/test:unit/test:architecture`；Vitest（jsdom + Testing Library + `@react-three/test-renderer`）、dependency-cruiser 均已接入。
- 真实浏览器行为不走自动化测试套件：涉及用户行为或浏览器生命周期的验证由执行 Task 的 Coding Agent 调用浏览器自动化技能在真实浏览器中自测，结论记入本文件第 5 节。
- 架构检查（`pnpm test:architecture`）以 `.dependency-cruiser.cjs` 规则校验真实 `src`（31 模块 0 违规），并用 `scripts/architecture/fixtures/` 正负例证明深层导入、核心 Feature 互导、受限公开入口、反向依赖和循环依赖必被抓到。
- 快速 CI 已建立：`.github/workflows/ci.yml` 执行 lint、typecheck、unit、architecture、build（build 已包含资源复制与 dist 校验）。
- 尚无地图解析、车辆模型、Mock、WebSocket、相机、质量控制或失败恢复实现；对应实现分属后续 Task。

### 2.3 当前数据输入

| 项目 | 当前值 |
|---|---:|
| 节点 | 4,291 |
| work / warehouse / charge / park | 3,045 / 1,185 / 59 / 2 |
| 逻辑边 | 9,265 |
| LINE / BEZIER | 5,963 / 3,302 |
| 物理路径 | 5,068（3,351 LINE / 1,717 BEZIER） |
| 反向重复几何 | 4,197 |
| 独占区 | 7，当前成员引用有效 |
| 弱连通分量节点数 | 2,001 / 1,187 / 796 / 307 |
| 当前车辆位置 | 与节点名称“1644”相距约 0.000042m |
| 当前车辆状态 | `TRAFFIC_WAIT`、`LOW_BATTERY`、loaded |
| 当前交通四边形 | locked 1 个、applying 3 个，均为有效凸四边形 |

## 3. 工程 Task 状态

| Task | 当前任务名称 | 真实依赖 | 状态 |
|---|---|---|---|
| TASK-001 | 工程、单 Canvas 与自动验证基线 | 无 | `DONE` |
| TASK-002 | 运行时配置、诊断、静态资源与部署基线 | 001 | `DONE` |
| TASK-003 | 统一坐标、地图校验与不可变 MapModel | 002 | `TODO` |
| TASK-004 | 可运行核心地图场景与恢复生命周期 | 003 | `TODO` |
| TASK-005 | 地图业务语义图层 | 004 | `TODO` |
| TASK-006 | 车辆领域模型、事件合同与车队运行时 | 001、002 | `TODO` |
| TASK-007 | WebSocket 数据源与 React 生命周期 | 006 | `TODO` |
| TASK-008 | Mock 拓扑、运动与充电内核 | 003、006 | `TODO` |
| TASK-009 | Mock 数据源、确定性场景与启动接线 | 007、008 | `TODO` |
| TASK-010 | AGV 程序化模型、槽位与实例批渲染 | 004、006、009 | `TODO` |
| TASK-011 | 图集化 WebGL 车辆标签 | 010 | `TODO` |
| TASK-012 | 选择、告警环与交通资源表达 | 010、011 | `TODO` |
| TASK-013 | 相机、车辆跟随与完整交互 | 004、010、012 | `TODO` |
| TASK-014 | 自适应质量与质量能力接线 | 005、011、012、013 | `TODO` |
| TASK-015 | 后台节流与前台瞬时对齐 | 009、010、013、014 | `TODO` |
| TASK-016 | WebGL 上下文丢失与恢复 | 005、010、011、012、014 | `TODO` |
| TASK-017 | 启动编排、失败恢复与跨 Feature 回归 | 007、009、013、015、016 | `TODO` |
| TASK-018 | 性能基准、指标采集与针对性调优 | 017 | `TODO` |
| TASK-019 | 稳定性压力工具与短时故障注入 | 018 | `TODO` |
| TASK-020 | 当前交付文档、部署样例与完整 CI | 017、018、019 | `TODO` |
| TASK-021 | 真实 WebSocket 协议联调 | 007、017、外部协议资料 | `WAITING_EXTERNAL` |

## 4. 当前 Task 工作卡

| 字段 | 当前内容 |
|---|---|
| Task | `TASK-003 统一坐标、地图校验与不可变 MapModel` |
| 状态 | `TODO` |
| 当前目标 | 应用可从运行时 mapUrl 加载当前地图，完成逐项隔离校验，建立稳定世界坐标、不可变索引和只读拓扑，并向场景与 Mock 暴露最小公共 API |
| 当前主要范围 | `src/shared/spatial/**`、`src/features/map-visualization/model/**`、`services/loadMap.ts`、Feature 公开入口、app 的地图启动接线和共置测试 |
| 当前已有实现 | TASK-001 单 Canvas 骨架与工具链；TASK-002 运行时配置（`RuntimeConfig.mapUrl` 已校验可用）、结构化诊断、启动编排与部署基线 |
| 当前待完成 | 以 `TASKS.md` 的 TASK-003 为准实现坐标变换、地图校验、MapModel 索引与全部验证 |
| 当前阻塞 | 无 |
| 完成后可开始 | TASK-004、TASK-008 |

Task 开始后，把本卡直接替换为实际进行中的工作：当前修改文件、当前成功验证、当前失败原因、当前剩余步骤和下一条可执行命令。Task 完成后删除已解决问题，只保留完成结果和新的当前指针。

## 5. 当前验证状态

| 范围 | 当前命令或检查 | 当前结果 |
|---|---|---|
| Lint | `pnpm lint` | 通过（0 警告 0 错误） |
| TypeScript | `pnpm typecheck`（`tsc -b`） | 通过 |
| 单元测试 | `pnpm test:unit -- src/app/bootstrap src/shared`（Vitest + jsdom，共 36 例：配置合法/非法/取消/网络/JSON/HTTPS-WS、诊断采样与隔离、校验原语、启动编排取消与上报、App/Scene 外壳） | 通过（36/36） |
| 架构检查 | `pnpm test:architecture`（真实 src 31 模块 0 违规；负例全部命中；正例零误报） | 通过 |
| 构建 | `pnpm build`（含 `copyStaticAssets` 与 `verifyDist`） | 通过 |
| dist 校验 | `pnpm verify:dist`（index/config/map 存在、相对路径引用、白名单与凭据检查、map.json 可解析） | 通过 |
| 部署冒烟 | `pnpm smoke:dist`（根路径 `/`、子路径 `/monitor/`、模拟配置失败 `/broken/` 三挂载 HTTP 冒烟） | 通过 |
| 锁定安装 | `pnpm install --frozen-lockfile` | 通过 |
| 浏览器自测 | Coding Agent 调用浏览器自动化技能（真实 Chromium 内核，1280×720）访问 `smoke:dist --hold` 静态服务器：根路径与 `/monitor/` 子路径均为唯一全屏 Canvas（绘制缓冲 1280×720）、无滚动、无任何 DOM 覆盖层、`config.json` 分别从 `/config.json` 与 `/monitor/config.json` 读取、截图为清屏底色；`/broken/`（config 500）下页面保持唯一清屏 Canvas、无错误 DOM、无滚动 | 通过（3/3 场景） |

浏览器自测备注：内嵌浏览器面板在后台加载时会节流 `requestAnimationFrame`，首次观测需把宿主窗口置前并重载后渲染帧才恢复；该现象属环境节流，不影响真实浏览器部署。诊断通道的控制台输出无法经该自动化接口直接读取，其上报行为由单元测试（`bootstrapApplication` 失败上报恰好一次、取消不上报）覆盖。

本节只保留当前 Task 的最终有效验证状态。重跑后直接替换结果；失败被修复后删除已失效的失败描述，不追加验证流水账。

## 6. 当前外部条件与 Gate

| 项目 | 当前状态 | 当前所需条件 |
|---|---|---|
| TASK-021 真实 WS | `WAITING_EXTERNAL` | 真实消息样例或 Schema、协议版本、鉴权、snapshot 方式、端点或正式录制夹具 |
| GATE-001 性能 | `NOT_READY` | TASK-018 完成，并提供符合 SPEC §6.1 或已证明不低于该组合的验收环境 |
| GATE-002 24h | `NOT_READY` | TASK-019 完成，并提供连续 24h 窗口及报告空间 |
| GATE-003 全量交付 | `NOT_READY` | 21 个工程 Task 全部完成，GATE-001 和 GATE-002 均通过 |

当前主机是 Windows 11、Intel Core i5-14500、Intel UHD Graphics 770、约 15.7GB 内存，同时存在虚拟显示驱动。当前没有足够证据把该环境直接认定为 SPEC §6.1 的正式验收环境，因此它可以用于开发和性能冒烟，不能单独把 GATE-001 标为通过。

## 7. 当前文档维护要求

- 本文件只保存当前状态，不保存交接历史、验证历史、决策历史或已失效基线。
- 状态、代码、Git 差异、外部条件或 Gate 结果变化时，直接替换对应内容并删除旧结论。
- 需要追溯修改过程时使用 Git；不得在本文件中通过不断追加行或章节记录过程。
