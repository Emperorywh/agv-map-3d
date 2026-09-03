# AGV 3D 数字孪生监控场景

React 19 + TypeScript + @react-three/fiber + Three.js 的单 Canvas AGV 实时监控
场景。产品与技术规格见 `docs/SPEC_20260901_agv-3d-monitor.md`，视觉对齐路线见
`docs/VISUAL_ALIGNMENT_PLAN.md`，各迭代截图取证见 `docs/visual-iterations/`。

## 开发

```bash
pnpm dev          # 开发服务器（Vite）
pnpm test:unit    # 单元测试（vitest）
pnpm typecheck    # TypeScript 检查
pnpm lint         # oxlint
pnpm test:architecture  # 依赖边界检查（dependency-cruiser）
pnpm build        # 生产构建 + 产物校验
```

## DEBUG MODE（仅开发环境）

开发服务器下给 URL 加 `?debug=1` 进入调试模式（会话内记忆，刷新保持；
`?debug=0` 强制关闭）。生产构建经 `import.meta.env.DEV` 静态消除，leva 依赖
不进产物。

- **图层开关**：按命名规则批量显隐 16 个场景图层（路面/中线/节点盘/仓储区域
  块/货架行/库位方垫/停车点/充电设施/独占区描边与填充/区域名称/车体/标签/
  状态环/交通锁）——逐层排除即可定位视觉 artifact 的归属对象；
- **Grid (5m)**：与地坪 5m 分缝同口径的调试网格；
- **Axes / BoundingBox / Light Helper**：坐标轴、地图包围盒、方向光辅助；
- **复制相机位姿 JSON**：相机位置 + FOV + 轨道目标点写入剪贴板与控制台，
  作为截图取证与 FROZEN 机位记录。

图层命名与匹配规则集中在 `src/app/debug/sceneLayerRegistry.ts`——Feature
图层场景命名变更时必须同步该注册表（有互斥不变量单测保护）。

## 原型

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.
