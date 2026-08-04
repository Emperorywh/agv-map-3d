# agv-map-3d

AGV 工厂地图 3D 可视化（v1）：加载一份 AGV 调度地图（节点 + 路径），在
Three.js 构建的完整工厂建筑内渲染——地坪漆面路径带（贴地，含方向箭头）、
按类型分色的节点圆点/站点圆环与朝向符号、CSS2D 距离迟滞标签；厂房含
程序纹理地坪、三段围墙（玻璃窗带）、开放屋顶钢桁架、天空/雾/室外外景。
相机为 45° 斜视全景初始机位，OrbitControls 漫游（旋转/缩放/平移），
无对象级交互。唯一工程规格见 [docs/SPEC.md](docs/SPEC.md)。

## 数据契约入口

- 默认数据源：`public/map.json`（运行时 fetch，换图只换文件，不重新打包）。
- 环境变量 `VITE_MAP_URL` 可指定同契约的另一个 URL（构建期注入，
  例：`VITE_MAP_URL=https://example.com/map.json pnpm build`）。
- 唯一合法信封：`{ code, message, data: { currentMapInfoVersion: { mapJson } } }`，
  `code` 严格等于 `200`；字段规则、15 秒超时、20MiB 上限与错误语义见 SPEC §3/§11。

## 脚本一览

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 开发服务器（默认 http://localhost:5173） |
| `pnpm build` | 类型检查（tsc -b）+ 生产构建（`dist/`） |
| `pnpm preview` | 预览生产构建 |
| `pnpm lint` | oxlint + 架构依赖方向检查（`scripts/check-architecture.mjs`） |
| `pnpm test` | 无浏览器单元测试（Vitest，SPEC §15.1）；`pnpm test --coverage` 输出 v8 覆盖率 |
| `pnpm check:arch` | 单独执行架构依赖方向检查（`--self-test` 为负例自测） |
| `pnpm build:harness` | 构建验收 harness（完整应用 + 测试桥 → `dist-harness/`），仅供验收设施使用 |
| `pnpm test:browser` | §15.2 五项浏览器用例（显式启动，见下） |
| `pnpm test:perf` | §10.2 PerformanceHarness 性能基准（显式启动，参考硬件） |
| `pnpm test:visual` | §15.3 视觉基线三机位截图（显式启动） |

`pnpm build` / `pnpm lint` / `pnpm test` 均不启动浏览器（§15.2）。

## 显式验收设施（tests/，SPEC §10.2 / §15.2 / §15.3）

以下设施由验收人员**显式启动**，不进入生产包。首次运行前安装冻结的
Chromium：`pnpm exec playwright install chromium`。完整步骤、报告必填字段、
环境记录模板与数据 SHA-256 复算方法见
[docs/ACCEPTANCE-RUNBOOK.md](docs/ACCEPTANCE-RUNBOOK.md)。

| 命令 | 内容 |
| --- | --- |
| `pnpm test:browser` | §15.2 五项浏览器用例：WebGL2 初始化渲染、CSS2D 生命周期与卸载后容器数为 0、resize（含 0 维暂停/恢复）、context lost 错误态、连续 10 次装卸资源基线 |
| `pnpm test:perf` | §10.2 PerformanceHarness 性能基准（参考展厅机器）：预热 10s → 全景 30s（初始 fit 距离、45° 俯角、匀速 180°）→ 近景 30s（35m、45°、180°）；六项指标断言；验收报告写入 `tests/perf/reports/`（硬件/浏览器完整版本/WebGL renderer 字符串/commit/数据 SHA-256/每项原始结果） |
| `pnpm test:visual` | §15.3 视觉基线：3840×2160 三机位截图（初始全景 / 35m 近景 / polarAngle=80° 低视线）写入 `tests/visual/baseline/`，供产品验收人确认后作为回归基线 |

机制说明：

- 三个命令共用 `playwright.config.ts` 的单一 `webServer`：先
  `pnpm build:harness`（完整应用 + 测试桥，输出到 `dist-harness/`），
  再以 `vite preview` 提供被测服务；启动、就绪检查、结束回收全部由
  Playwright 自管理。
- 测试桥（`window.__FACTORY_MAP_TEST_BRIDGE__`）与 PerformanceHarness 只在
  harness 构建中打包；生产构建 `pnpm build` 的 `dist/` 不含 harness 标识
  （可用 `grep -ri "PerformanceHarness" dist/` 验证）。
- `test:perf` / `test:visual` 的画布固定 3840×2160 CSS 像素、
  `deviceScaleFactor=1`（§10.2 的 dpr=1 口径）。在参考硬件
  （i5-12400/R5 5600、16GB、RTX 3060/RX 6600 同级）上运行；无 GPU 环境会
  体现在报告的 WebGL renderer 字符串中，性能结论仅在参考硬件上有效。

## 交付文档

| 文档 | 内容 |
| --- | --- |
| [docs/SPEC.md](docs/SPEC.md) | v1 唯一工程规格（不得修改） |
| [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) | 最终验收核对记录：全量回归与覆盖率证据、生产包审计、§17 验收清单逐条结论、§16 M0–M5 里程碑证据映射 |
| [docs/ACCEPTANCE-RUNBOOK.md](docs/ACCEPTANCE-RUNBOOK.md) | 验收运行手册：显式设施步骤、人工核对动线、报告必填字段、参考环境记录模板、数据 SHA-256 计算方法 |

## 目录结构

```
src/features/factory-map/   # 唯一功能模块（index.ts 为公开出口）
├── domain/                 # 纯 TS：信封解码、不变量、坐标、bounds、错误码
├── application/            # 端口、FactorySceneModel 契约、页面状态机、加载用例
├── infrastructure/         # HttpMapRepository、Worker（协议/构建器/preparer）
├── rendering/              # core（绑定/相机 fit）、resources（资源 owner）、scene（R3F 层）
├── presentation/           # FactoryMapPage、PageController、PageStateView
└── config/                 # §13 固定常量与 §6.8/§7 配色
tests/                      # 显式验收设施（browser/perf/visual/harness/shared）
scripts/                    # 架构依赖方向检查
public/map.json             # 基准地图数据（唯一运行时数据资源）
```
