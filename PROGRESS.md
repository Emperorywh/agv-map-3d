# AGV 3D 实时监控大屏实施进度

状态日期：2026-09-01

任务书版本：`TASKS.md` v2.0

规格版本：`SPEC-20260901-agv-3d-monitor` v1.3

## 1. 当前执行状态

| 字段 | 当前值 |
|---|---|
| 项目状态 | `PLANNED` |
| 当前 Task | `TASK-001 工程、单 Canvas 与自动验证基线` |
| 当前 Task 状态 | `TODO` |
| 已完成工程 Task | `0 / 21` |
| 条件任务 | `TASK-021 WAITING_EXTERNAL` |
| 验收 Gate | GATE-001、GATE-002、GATE-003 均为 `NOT_READY` |
| 当前下一步 | 完整读取 TASK-001、SPEC、当前代码和 Git 差异，将 TASK-001 改为 `IN_PROGRESS` 后完成该 Task 的代码、接线与验证 |
| 项目完成条件 | TASK-001～TASK-021 全部 `DONE`，GATE-001～GATE-003 全部通过，SPEC A1～F6 均有当前证据 |

编号是推荐交付顺序，执行前必须核对真实依赖。`WAITING_EXTERNAL` 的 TASK-021 不阻塞 TASK-018～020；其他 Task 只有在自身依赖全部 `DONE` 后才能开始。

## 2. 当前仓库状态

### 2.1 Git 与工作区

| 项目 | 当前值 |
|---|---|
| 工作区 | `C:\code\agv-map-3d` |
| 分支 | `rxx`，跟踪 `origin/rxx` |
| HEAD | `15e81cef1959e210b2d78a4f58faa48fcfd0623e` |
| 规划文档 | `TASKS.md`、`PROGRESS.md` 存在未提交的当前工作区修改 |
| 用户输入 | `docs/SPEC_20260901_agv-3d-monitor.md`、原型图、`json/map.json`、`json/vehicle.json` 存在已暂存差异 |

所有未提交差异均必须保留。每个 Task 开始和结束时以实际 `git status --short --branch` 为准，并直接更新本节当前值；不得恢复旧状态或把差异写成历史日志。

### 2.2 当前实现

- `src/main.tsx`、`src/App.tsx`、`src/App.css` 和 `src/index.css` 仍是 Vite React 演示模板。
- 当前没有 `src/app`、`src/features`、`src/shared`、`tests`、运行时 `public/config.json` 或静态资源脚本。
- 当前没有地图、车辆、Mock、WebSocket、相机、质量控制、失败恢复或性能实现。
- `package.json` 只有 `dev/build/lint/preview`；没有 typecheck、unit、E2E、architecture 或 dist 校验脚本。
- 当前没有 Vitest、Playwright 或测试配置；`@react-three/drei` 和 zustand 也不是直接依赖。
- Git 忽略的现有 `dist` 是与当前规格冲突的陈旧产物，不是源码或验收证据。

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
| TASK-001 | 工程、单 Canvas 与自动验证基线 | 无 | `TODO` |
| TASK-002 | 运行时配置、诊断、静态资源与部署基线 | 001 | `TODO` |
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
| Task | `TASK-001 工程、单 Canvas 与自动验证基线` |
| 状态 | `TODO` |
| 当前目标 | 建立依赖、测试、架构检查、快速 CI 和唯一全屏 Canvas 应用骨架 |
| 当前主要范围 | package/lock、TS/Vite/Vitest/Playwright、架构脚本、CI、`src/main.tsx`、`src/app/**`、模板样式和资源 |
| 当前已有实现 | 只有 Vite React 模板及现有基础依赖 |
| 当前待完成 | 以 `TASKS.md` 的 TASK-001 为准完成全部代码、接线、正负测试和 build |
| 当前阻塞 | 无 |
| 完成后可开始 | TASK-002；TASK-006 也将满足其 TASK-001 前置，但推荐先完成 TASK-002 |

Task 开始后，把本卡直接替换为实际进行中的工作：当前修改文件、当前成功验证、当前失败原因、当前剩余步骤和下一条可执行命令。Task 完成后删除已解决问题，只保留完成结果和新的当前指针。

## 5. 当前验证状态

| 范围 | 当前命令或检查 | 当前结果 |
|---|---|---|
| 模板 lint | `pnpm lint` | 通过 |
| 模板 TypeScript | `pnpm exec tsc -b --pretty false` | 通过；独立 `typecheck` 脚本尚未建立 |
| 模板构建 | `pnpm exec vite build --outDir <隔离临时目录>` | 通过；未把陈旧 `dist` 作为证据 |
| 单元测试 | Vitest 配置和脚本 | 尚不存在，由 TASK-001 建立 |
| E2E | Playwright 配置和脚本 | 尚不存在，由 TASK-001 建立 |
| 架构检查 | 依赖边界配置和脚本 | 尚不存在，由 TASK-001 建立 |

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
