# agv-map-3d

AGV 工厂地图 3D 可视化（v1）。唯一工程规格见 `docs/SPEC.md`。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 开发服务器 |
| `pnpm build` | 类型检查 + 生产构建（`dist/`） |
| `pnpm lint` | oxlint + 架构依赖方向检查（`scripts/check-architecture.mjs`） |
| `pnpm test` | 无浏览器单元测试（Vitest，SPEC §15.1） |

`pnpm build` / `pnpm lint` / `pnpm test` 均不启动浏览器（§15.2）。

## 显式验收设施（tests/，SPEC §10.2 / §15.2 / §15.3）

以下设施由验收人员**显式启动**，不进入生产包。首次运行前安装冻结的
Chromium：`pnpm exec playwright install chromium`。

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
- `test:perf` 的画布固定 3840×2160 CSS 像素、`deviceScaleFactor=1`
  （§10.2 的 dpr=1 口径）。在参考硬件（i5-12400/R5 5600、16GB、
  RTX 3060/RX 6600 同级）上运行；无 GPU 环境会体现在报告的 WebGL
  renderer 字符串中，性能结论仅在参考硬件上有效。
