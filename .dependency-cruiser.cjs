/**
 * 依赖边界规则（SPEC §12.4）。
 *
 * 职责：以 dependency-cruiser 规则静态锁定 Feature-Based 架构的依赖方向。
 * 关键不变量：
 * 1. 所有模块只能从 `src/features/<name>/index.ts` 公开入口导入其他 Feature；
 * 2. map-visualization、fleet-monitoring、render-quality 三者之间禁止任何互相导入；
 * 3. mock-simulation 与 camera-navigation 只允许导入 map-visualization、
 *    fleet-monitoring 的 index.ts（自身 Feature 内部导入不受此约束）；
 * 4. shared 不得依赖 app 或任何 Feature（反向依赖）；
 * 5. Feature 不得依赖 app（反向依赖）；
 * 6. 整个 src 禁止循环依赖。
 * 路径均为相对 baseDir 的 POSIX 风格（如 `src/app/App.tsx`）。
 */

const FEATURES = [
  'map-visualization',
  'fleet-monitoring',
  'camera-navigation',
  'mock-simulation',
  'render-quality',
]

// 这三个 Feature 之间按 SPEC 不得互相导入
const CORE_FEATURES = ['map-visualization', 'fleet-monitoring', 'render-quality']

const forbidden = [
  // 每个 Feature 的内部文件禁止被 Feature 外部深层导入（公开入口 index.ts 除外）
  ...FEATURES.map((feature) => ({
    name: `feature-${feature}-deep-import-forbidden`,
    severity: 'error',
    comment: `禁止从 Feature 外部导入 ${feature} 的内部文件；只允许其 index.ts 公开入口`,
    from: { pathNot: `^src/features/${feature}/` },
    to: {
      path: `^src/features/${feature}/`,
      pathNot: `^src/features/${feature}/index\\.ts$`,
    },
  })),

  // 核心三 Feature（地图 / 车队 / 质量）之间禁止任何互相导入
  ...CORE_FEATURES.map((feature) => ({
    name: `core-feature-${feature}-no-cross-feature-import`,
    severity: 'error',
    comment: `${feature} 只允许依赖 shared，禁止导入任何其他 Feature`,
    from: { path: `^src/features/${feature}/` },
    to: { path: '^src/features/', pathNot: `^src/features/${feature}/` },
  })),

  // mock-simulation / camera-navigation 各自只允许通过两个宿主 Feature 的
  // index.ts 复用公开类型；自身 Feature 内部的相对导入（model/**、共置测试
  // 夹具互引等）是正常 Feature 结构，不属于跨 Feature 边界，按自身目录豁免
  ...['mock-simulation', 'camera-navigation'].map((feature) => ({
    name: `adapter-${feature}-public-entry-only`,
    severity: 'error',
    comment:
      `${feature} 只允许导入 map-visualization、fleet-monitoring 的 index.ts；` +
      '自身 Feature 内部导入不受此约束',
    from: { path: `^src/features/${feature}/` },
    to: {
      path: '^src/features/',
      pathNot: [
        `^src/features/${feature}/`,
        '^src/features/(map-visualization|fleet-monitoring)/index\\.ts$',
      ],
    },
  })),

  // app 只能从 Feature 的 index.ts 公开入口导入
  {
    name: 'app-feature-public-entry-only',
    severity: 'error',
    comment: 'app 只允许导入各 Feature 的 index.ts 公开入口，禁止深层导入',
    from: { path: '^src/app/' },
    to: {
      path: '^src/features/',
      pathNot: '^src/features/[^/]+/index\\.ts$',
    },
  },

  // shared 是最底层：不得依赖 app 或任何 Feature（反向依赖）
  {
    name: 'shared-independence',
    severity: 'error',
    comment: 'shared 不得依赖 app 或任何 Feature',
    from: { path: '^src/shared/' },
    to: { path: '^(src/app|src/features)/' },
  },

  // Feature 不得依赖 app（反向依赖；跨 Feature 协作必须由 app 注入）
  {
    name: 'no-feature-to-app-import',
    severity: 'error',
    comment: 'Feature 不得导入 app；跨 Feature 协作只能由 app 通过 props/回调注入',
    from: { path: '^src/features/' },
    to: { path: '^src/app/' },
  },

  // 全 src 禁止循环依赖
  {
    name: 'no-circular',
    severity: 'error',
    comment: 'src 内禁止任何循环依赖',
    from: {},
    to: { circular: true },
  },
]

module.exports = { forbidden }
