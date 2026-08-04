# 验收运行手册（SPEC §10.2 / §15.2 / §15.3 / §17）

> 读者：验收人员与产品验收人。本手册给出全部验收活动的显式执行步骤、
> 报告必填字段、参考环境记录模板与数据 SHA-256 复算方法。
> 机器可核项的既有结论见 [验收核对记录](./ACCEPTANCE.md)。

## 1. 环境前置（SPEC §1.3）

| 项 | 要求 |
| --- | --- |
| 硬件 | Intel Core i5-12400 / AMD Ryzen 5 5600 同级 CPU、16GB 内存、NVIDIA RTX 3060 / AMD RX 6600 同级独显（低于此不属 v1 性能承诺范围） |
| 画布 | 3840×2160 CSS 尺寸，操作系统显示缩放与浏览器缩放均固定 100%（有效 dpr=1） |
| 浏览器 | 目标展厅机器上交付时冻结的 Chromium 稳定版；完整版本与 WebGL renderer 字符串必须记入验收报告 |
| Node / pnpm | 能执行 `pnpm install --frozen-lockfile` 的环境（Node ≥ 20 建议） |

## 2. 一次性准备

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install chromium   # 安装 Playwright 冻结的 Chromium（首次）
```

## 3. 基线回归（机器门禁，约 1 分钟）

```bash
pnpm install --frozen-lockfile && pnpm build && pnpm lint && pnpm test && pnpm check:arch
```

五条命令须依次退出 0。可选覆盖率复现：`pnpm test --coverage`
（domain / application / infrastructure / rendering-core 分支覆盖率应均为 100%，
≥90% 为 §15.1 门槛；coverage/ 为临时产物，核对后可删除）。

生产包快速审计（可选复跑）：

```bash
grep -ri "GLTFLoader\|useGLTF\|DRACOLoader\|KTX2Loader" dist/   # 应无匹配
grep -ri "PerformanceHarness\|__FACTORY_MAP_TEST_BRIDGE__" dist/ # 应无匹配
```

## 4. 显式验收设施（§15.2：由验收人员显式启动）

三个命令共用 `playwright.config.ts` 的单一 webServer：自动执行
`pnpm build:harness`（完整应用 + 测试桥 → `dist-harness/`）并以
`vite preview`（127.0.0.1:4173）提供被测服务；启动、就绪检查、结束回收
全部自管理，无需也不应预先启动任何服务。`pnpm build/lint/test` 不经过这些设施。

### 4.1 `pnpm test:browser` —— §15.2 五项浏览器用例

| 用例 | 内容 |
| --- | --- |
| webgl-init | WebGL2 上下文创建、demand 帧驱动产生实际渲染（draw calls > 0）、drawing buffer 与 dpr 口径一致、无错误 overlay |
| css2d-lifecycle | 初始全景无标签 → 35m 近景标签出现且 ≤300、容器恰 1 个 → 卸载后容器数为 0 → 重载完整重建 |
| resize | 视口变化重算 aspect/drawing buffer；宿主 0 维暂停 setSize/render，恢复后重算 |
| context-lost | 真实 context lost → WEBGL_CONTEXT_LOST 全屏错误态、「刷新页面」按钮、不自动恢复 |
| resource-baseline | 连续 10 次装卸后 `renderer.info.memory` 回首次卸载基线 |

通过即五项全绿；失败时先读 Playwright 输出中的断言与页面状态日志。

### 4.2 `pnpm test:perf` —— §10.2 性能基准（须在参考硬件上执行）

流程（单一用例自动完成）：等待 ready → 连续 10 轮装卸采集 Worker prepare /
主线程绑定样本 → PerformanceHarness 预热 10s → 全景 30s（初始 fit 距离、
45° 俯角、匀速 180°）→ 近景 30s（35m、45°、180°，触发标签 300 上限）→
写报告 → 六项指标断言（任一失败即性能验收失败）：

1. 全景阶段帧时间 p95 ≤33.3ms 且 p99 ≤50ms
2. 近景阶段帧时间 p95 ≤33.3ms 且 p99 ≤50ms
3. ready 后测试阶段无 >100ms 主线程 long task
4. Worker prepare 连续 10 次 p95 ≤500ms
5. 主线程 SceneModel 绑定 p95 ≤16.7ms
6. 全程 draw calls ≤25、CSS2D 标签 ≤300、容器 ≤1；10 次装卸后资源回基线、容器数为 0

产物：`tests/perf/reports/perf-report-<时间戳>.json`（并随 Playwright 附件归档）。

**报告必填字段**（§10.2/§1.3，报告已自动生成全部字段，验收人核对不得缺项）：

| 字段 | 来源 |
| --- | --- |
| 硬件（CPU 型号/核数、内存、平台/OS、架构） | `environment.*`（Node os 模块采集） |
| 浏览器完整版本 | `environment.browserVersion`（冻结 Chromium） |
| WebGL renderer 字符串 | `webglRenderer`（UNMASKED，证明实际 GPU） |
| commit | `environment.commit`（git HEAD） |
| 数据文件 SHA-256 | `dataSha256`（页面实际消费字节计算，须与 §7 手工复算一致） |
| 每项原始结果 | `metrics.*`（两阶段帧时间分布、longtask 明细、prepare/bind 原始样本、draw call/DOM 峰值、装卸内存序列）与 `raw.*`（逐帧样本） |
| 质量口径快照 | `quality`（cssWidth/cssHeight/drawingBuffer/dpr/shadowMapSize/labelMaxCount，防规避证据） |

### 4.3 `pnpm test:visual` —— §15.3 视觉基线捕获

固定捕获三张 3840×2160 截图（deviceScaleFactor=1，PNG 尺寸经 IHDR 断言）：

| 文件 | 机位 |
| --- | --- |
| `tests/visual/baseline/01-initial-panorama.png` | 初始全景（§9.1 fit，45° 斜视） |
| `tests/visual/baseline/02-near-35m.png` | 35m 近景（45° 俯角） |
| `tests/visual/baseline/03-low-polar-80deg.png` | polarAngle=80° 低视线（距地平线 10°） |

同目录写 `manifest.json`（环境/WebGL renderer/数据 SHA-256/三机位实际位姿）。

**视觉基线确认流程**：产品验收人对照三张截图一次性确认配色、曝光、雾、
阴影和建筑观感；确认后这三张图即后续视觉回归基线——之后的同机位截图与
基线不得存在未批准的结构、材质或配色变化，不以「感觉接近」替代。

## 5. 人工核对动线（`pnpm dev`，默认 http://localhost:5173）

### 漫游（§17 Orbit 项）

- 左键拖拽旋转、滚轮缩放、右键拖拽平移；
- 缩放极限：最近 3m / 最远 350m；俯角限制：视线不能进入地面以下（maxPolar 80°），可接近正俯视（minPolar 5°）；
- 任意操作后 target Y 恒为 0，XZ 不越过厂房内边界外扩 20m（推到边界继续拖，视点被夹住）。

### 标签（§17 标签项）

- 初始全景无标签（基准地图全景最近距离 >90m，属明确设计）；
- 拉近到 35m 附近：站点/节点/路径标签按类别出现，白底 pill、屏幕恒定 12px；
- 缓慢推拉验证迟滞（进入/退出距离不同，不抖动）；隔着实墙/桁架的候选被遮挡跳过，玻璃不遮挡；
- 高密度近景标签总数不超过 300。

### z-fighting（§17 对向共线项）

初始全景、35m 近景、polarAngle≈80° 低视线三个机位各持续观察 30 秒，
对向共线路径（灰白与红重叠段）不得出现闪烁（双保险：毫米级高度差 + polygonOffset）。

### 玻璃 / 开放屋顶 / 雾（§17 玻璃项）

- 低视线机位透过 4.0~6.5m 玻璃带可见天空与外景，玻璃后方无实墙；
- 任意俯角穿过屋顶钢桁架（无屋面板）可见天空；
- 远景室外地面柔和融入雾色；玻璃不投阴影、无错误深度遮挡。

### 无对象交互（§17 无交互项）

对路径/节点/标签/厂房点击、悬停、右键，页面与 3D 场景均无响应
（仅错误态下的 DOM「重新加载/刷新页面」按钮可聚焦点击，属 §1.4 要求）。

### 错误态抽查（§11 矩阵；自动化已覆盖，以下为人工复现步骤）

| 场景 | 操作 | 预期 |
| --- | --- | --- |
| 断网 | DevTools → Network → Offline 后刷新页面 | MapNetworkError 错误码/摘要 +「重新加载」；关闭 Offline 点「重新加载」恢复 |
| HTTP 错误 | `VITE_MAP_URL=/missing.json pnpm dev`（bash；PowerShell 用 `$env:VITE_MAP_URL="/missing.json"`） | MapHttpError：显示 404 与请求 URL（无 query/hash） |
| 坏 JSON | 备份后把 `public/map.json` 改为截断内容 | MapParseError，不展示原始响应内容 |
| 坏信封 | 把顶层 `code` 改为 500 | MapEnvelopeError：稳定错误码 + 字段路径 |
| 坏字段 | 把 `nodes[0].type` 改为 `"unknown"` | MapValidationError：`nodes[0].type` + 中文摘要 |
| 空图 | `nodes`/`edges` 同时置空数组 | empty 态：60×40m 空厂房可漫游 +「暂无地图数据」 |

抽查后恢复 `public/map.json` 备份并确认 `git status` 干净。
Worker 崩溃与 WebGL 失败不易手工复现，以 `pnpm test:browser` 自动化用例为准。

## 6. 参考环境记录模板

验收报告随附下表（`pnpm test:perf` 报告的 `environment` / `webglRenderer` /
`dataSha256` 字段已自动填写前七行，验收人补充 GPU 与确认人）：

| 字段 | 示例 | 实测填写 |
| --- | --- | --- |
| CPU | Intel Core i5-12400 | |
| CPU 核数 / 内存 | 12 核 / 16GB | |
| GPU（WebGL renderer 字符串） | ANGLE (NVIDIA GeForce RTX 3060 …) | |
| OS / 架构 | Windows 11 23H2 / x64 | |
| 浏览器完整版本 | Chromium 141.x.x.x（Playwright 冻结） | |
| Node / Playwright 版本 | v22.x / 1.62.1 | |
| commit | git rev-parse HEAD | |
| 数据 SHA-256 | 见 §7 | |
| 画布 / 缩放 | 3840×2160 CSS / 系统与浏览器缩放 100% / dpr=1 | |
| 验收人 / 日期 | | |

## 7. 数据 SHA-256 计算方法

- **自动（推荐）**：验收设施对页面实际消费的 `/map.json` 字节执行
  `crypto.subtle.digest('SHA-256', …)`，小写十六进制写入报告 `dataSha256`
  与视觉基线 `manifest.json`。
- **手工复算**（对交付的 `public/map.json`，结果必须与报告一致）：

```bash
# Windows（cmd，无需安装）
certutil -hashfile public\map.json SHA256

# Windows PowerShell
(Get-FileHash public\map.json -Algorithm SHA256).Hash.ToLower()

# macOS
shasum -a 256 public/map.json

# Linux
sha256sum public/map.json

# 跨平台 Node 一行
node -e "const c=require('crypto'),f=require('fs');console.log(c.createHash('sha256').update(f.readFileSync('public/map.json')).digest('hex'))"
```

换图（替换 `public/map.json` 或改用 `VITE_MAP_URL`）后必须重新计算并把新值
记入验收报告；性能与视觉结论只对报告所记哈希的数据有效。

## 8. 故障排查

| 症状 | 处理 |
| --- | --- |
| playwright 启动失败：4173 端口占用 | webServer 为 strictPort 且不复用既有服务；结束占用进程后重跑 |
| 报告 WebGL renderer 含 SwiftShader/llvmpipe | 无 GPU 环境，性能结论无效；须在参考硬件重跑 |
| `pnpm exec playwright install chromium` 下载失败 | 按公司镜像/代理配置 `PLAYWRIGHT_DOWNLOAD_HOST` 后重试 |
| 测试后残留 `dist-harness/`、`test-results/`、`playwright-report/` | 均为 gitignore 的瞬态产物，可直接删除 |
