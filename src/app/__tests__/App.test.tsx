/*
 * App DOM 外壳与启动接线测试（与实现共置）。
 *
 * 职责：以 jsdom + Testing Library 校验应用组合根的 DOM 结构与启动状态传递。
 * 因 jsdom 无 WebGL，本文件将 @react-three/fiber 的 Canvas 替换为等价 DOM
 * 骨架，并将地图 Feature 根组件替换为捕获 props 的替身——只验证 App 层的
 * 编排合同，不验证场景内容（后者由 AgvMonitorScene/Feature 测试覆盖）。
 * 关键不变量（TASK-001 / TASK-004 / D2 / §7.4 / §11.10）：
 * 1. App 渲染的 DOM 中只存在一个 canvas 元素，尺寸 100vw × 100dvh；
 * 2. 不存在按钮、标题、面板等任何 DOM 覆盖层（启动失败时同样如此）；
 * 3. 启动就绪后向场景传递地图描述符（含 bootstrap 种子）；
 * 4. 配置失败为终态（保持 null 描述符、无重试）；地图阶段失败按退避自动
 *    重试直至成功；
 * 5. StrictMode 双执行下 bootstrap 重复调用被取消机制收敛为单条启动链路。
 */
import { StrictMode } from 'react'
import type React from 'react'
import { act, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from '@/app/App'
import { bootstrapApplication } from '@/app/bootstrap/bootstrapApplication'
import { StructuredError } from '@/shared/diagnostics'
import type { WorldTransform } from '@/shared/spatial'
import {
  createMapModel,
  validateMap,
  type MapModel,
} from '@/features/map-visualization'

vi.mock('@react-three/fiber', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@react-three/fiber')>()
  return {
    ...actual,
    Canvas: ({
      style,
      children,
      frameloop,
    }: {
      style?: React.CSSProperties
      children?: React.ReactNode
      frameloop?: 'always' | 'demand' | 'never'
    }) => (
      <div data-testid="canvas-shell" data-frameloop={frameloop ?? 'always'} style={style}>
        <canvas />
        {children}
      </div>
    ),
  }
})

/** 捕获传给地图 Feature 的描述符（vi.hoisted 保证工厂内可引用） */
const capture = vi.hoisted(() => ({
  mapDescriptor: undefined as unknown,
  shadowMapSize: undefined as unknown,
}))

/** 捕获数据源选择入参（保持 App 外壳测试与 Mock 内核实现解耦） */
const selectCapture = vi.hoisted(() => ({
  options: [] as unknown[],
  returnValue: null as unknown,
}))

vi.mock('@/features/map-visualization', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/features/map-visualization')>()
  return {
    ...actual,
    MapVisualizationFeature: (props: { map: unknown; shadowMapSize?: number }) => {
      capture.mapDescriptor = props.map
      capture.shadowMapSize = props.shadowMapSize
      return <div data-testid="map-feature" />
    },
  }
})

/** 捕获传给车队 Feature 的世界变换（TASK-010 接线：app 注入坐标转换） */
const fleetCapture = vi.hoisted(() => ({
  worldTransform: undefined as unknown,
}))

vi.mock('@/features/fleet-monitoring', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/features/fleet-monitoring')>()
  return {
    ...actual,
    // jsdom 无 R3F 宿主：场景子组件以 DOM 替身验证 App 层接线合同
    FleetRuntimeProvider: ({ children }: { children?: React.ReactNode }) => (
      <>{children}</>
    ),
    FleetMonitoringFeature: (props: { worldTransform: unknown }) => {
      fleetCapture.worldTransform = props.worldTransform
      return <div data-testid="fleet-feature" />
    },
  }
})

/** 捕获传给相机 Feature 的包围盒（TASK-013 接线：组合层桥接取景来源） */
const cameraCapture = vi.hoisted(() => ({
  bounds: undefined as unknown,
}))

vi.mock('@/features/camera-navigation', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/features/camera-navigation')>()
  return {
    ...actual,
    // jsdom 无 R3F 宿主：相机 Feature 以 DOM 替身验证 App 层接线合同
    CameraNavigationFeature: (props: { bounds: unknown }) => {
      cameraCapture.bounds = props.bounds
      return <div data-testid="camera-feature" />
    },
  }
})

/** 捕获传给质量 Feature 的 DPR 上限（TASK-014 接线：config.renderer 传递） */
const qualityCapture = vi.hoisted(() => ({
  maxDpr: undefined as unknown,
}))

vi.mock('@/features/render-quality', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/features/render-quality')>()
  return {
    ...actual,
    // jsdom 无 R3F 宿主：质量 Feature 以 DOM 替身验证组合层接线合同；
    // 能力映射与等级订阅走真实实现（纯函数与低频 store，不依赖 R3F）
    RenderQualityFeature: (props: { maxDpr: unknown }) => {
      qualityCapture.maxDpr = props.maxDpr
      return <div data-testid="quality-feature" />
    },
    useQualityLevel: () => 0,
  }
})

vi.mock('@/app/bootstrap/bootstrapApplication', () => ({
  bootstrapApplication: vi.fn(),
}))

vi.mock('@/app/bootstrap/selectVehicleDataSource', () => ({
  selectVehicleDataSource: (options: unknown) => {
    selectCapture.options.push(options)
    return selectCapture.returnValue
  },
}))

const mockBootstrap = vi.mocked(bootstrapApplication)

/**
 * 设置页面可见性并派发 visibilitychange（jsdom 无真实切换）：
 * 实时改写 document.visibilityState 后手动派发，与实现「回调内实时读取」
 * 的约定一致。
 */
function setPageVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    value: state,
    configurable: true,
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

/** 微任务冲刷 */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

const RUNTIME_CONFIG = {
  dataSource: 'mock',
  mapUrl: './json/map.json',
  wsUrl: null,
  maxVehicles: 256,
  staleAfterMs: 10000,
  renderer: { maxDpr: 1.5, shadowMapSize: 2048 },
  coordinateTransform: { scale: 1, rotation: 0, mirrorY: false, translateX: 0, translateY: 0 },
} as const

function buildBootstrapResult(): {
  config: typeof RUNTIME_CONFIG
  configUrl: string
  mapUrl: string
  mapModel: MapModel
  worldTransform: WorldTransform
} {
  const { mapModel, worldTransform } = createMapModel(
    validateMap({
      nodes: [
        { id: 'a', name: 'A', type: 'work', mapId: 'm1', highPrecision: false, x: 0, y: 0, angle: null },
        { id: 'b', name: 'B', type: 'work', mapId: 'm1', highPrecision: false, x: 3, y: 4, angle: null },
      ],
      edges: [
        {
          id: 'e1',
          mapId: 'm1',
          edgeType: 'LINE',
          sx: 0,
          sy: 0,
          ex: 3,
          ey: 4,
          cx: null,
          cy: null,
          dx: null,
          dy: null,
          isBackEdge: false,
          cost: 5,
          maxLoadSpeed: 1,
          maxFreeSpeed: 1,
          maxLoadRotationSpeed: null,
          maxFreeRotationSpeed: null,
          loadSecurity: null,
          freeSecurity: null,
          snodeId: 'a',
          enodeId: 'b',
        },
      ],
      zones: [],
      nodeEdgeGroups: [],
    }),
  )
  return {
    config: RUNTIME_CONFIG,
    configUrl: 'http://t/config.json',
    mapUrl: 'http://t/json/map.json',
    mapModel,
    worldTransform,
  }
}

afterEach(() => {
  vi.useRealTimers()
  mockBootstrap.mockReset()
  capture.mapDescriptor = undefined
  capture.shadowMapSize = undefined
  fleetCapture.worldTransform = undefined
  cameraCapture.bounds = undefined
  qualityCapture.maxDpr = undefined
  selectCapture.options = []
  selectCapture.returnValue = null
  // 恢复可见性，避免影响同文件其他用例的挂载初始态
  setPageVisibility('visible')
})

describe('App DOM 外壳', () => {
  it('只挂载一个 canvas 且占满 100vw × 100dvh，启动期间无地图描述符', async () => {
    mockBootstrap.mockReturnValue(new Promise(() => {}))
    const { container } = render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
    const canvases = container.querySelectorAll('canvas')
    expect(canvases).toHaveLength(1)

    const shell = container.querySelector<HTMLElement>(
      '[data-testid="canvas-shell"]',
    )
    expect(shell).not.toBeNull()
    // jsdom 会把视口单位解析为像素值，因此直接断言内联样式声明
    expect(shell!.style.width).toBe('100vw')
    expect(shell!.style.height).toBe('100dvh')
    // 启动未就绪：场景不持有地图描述符
    expect(capture.mapDescriptor).toBeNull()
  })

  it('不存在任何 DOM 覆盖层元素', () => {
    mockBootstrap.mockReturnValue(new Promise(() => {}))
    const { container } = render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
    expect(
      container.querySelector(
        'button, header, nav, aside, footer, dialog, input, select, textarea, [role="dialog"]',
      ),
    ).toBeNull()
  })

  it('启动就绪后向场景传递含 bootstrap 种子的地图描述符', async () => {
    const result = buildBootstrapResult()
    mockBootstrap.mockResolvedValue(result)
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
    // StrictMode 双执行：第一条链路被取消机制收敛，仍只产出一次有效结果
    await waitFor(() => expect(capture.mapDescriptor).not.toBeNull())
    const descriptor = capture.mapDescriptor as {
      mapUrl: string
      initial: { mapModel: MapModel }
    }
    expect(descriptor.mapUrl).toBe('http://t/json/map.json')
    expect(descriptor.initial.mapModel).toBe(result.mapModel)
    // TASK-010 接线：世界变换与描述符同源注入车队 Feature（坐标唯一口径）
    await waitFor(() => expect(fleetCapture.worldTransform).not.toBeNull())
    expect(fleetCapture.worldTransform).toBe(result.worldTransform)
    // TASK-013 接线：相机 Feature 的取景包围盒取自同一种子的场景包围盒
    await waitFor(() => expect(cameraCapture.bounds).not.toBeNull())
    expect(cameraCapture.bounds).toBe(result.mapModel.sceneBounds)
    // TASK-014 接线：config.renderer 经组合层传入质量 Feature 与地图阴影配置
    await waitFor(() => expect(qualityCapture.maxDpr).not.toBeNull())
    expect(qualityCapture.maxDpr).toBe(RUNTIME_CONFIG.renderer.maxDpr)
    expect(capture.shadowMapSize).toBe(RUNTIME_CONFIG.renderer.shadowMapSize)
  })

  it('数据源选择按就绪配置执行一次，Mock 分支携带地图拓扑（TASK-009）', async () => {
    const result = buildBootstrapResult()
    mockBootstrap.mockResolvedValue(result)
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
    await waitFor(() => expect(selectCapture.options.length).toBeGreaterThan(0))
    const options = selectCapture.options[0] as {
      config: { dataSource: string }
      mapId: string
      mapModel: MapModel
    }
    expect(options.config.dataSource).toBe('mock')
    expect(options.mapId).toBe(result.mapModel.mapId)
    // Mock 必须在 MapModel 拓扑就绪后创建：选择入参携带同一模型引用
    expect(options.mapModel).toBe(result.mapModel)
  })

  it('__AGV_MOCK__ 注册到已提交的 Mock 数据源实例，卸载后对称摘除（TASK-009）', async () => {
    mockBootstrap.mockResolvedValue(buildBootstrapResult())
    // 带 devControl 的假 Mock 数据源：无计时器、连接立即兑现
    const devControl = { getStats: () => ({ fleetSize: 1 }) }
    const fakeMockSource = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      requestSnapshot: vi.fn(),
      status: 'OPEN' as const,
      onEvent: vi.fn().mockReturnValue(() => {}),
      onStatusChange: vi.fn().mockReturnValue(() => {}),
      devControl,
    }
    selectCapture.returnValue = fakeMockSource

    const { unmount } = render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
    // StrictMode setup→cleanup→setup 收敛后，桥指向同一提交实例的控制接口
    await waitFor(() =>
      expect((globalThis as Record<string, unknown>)['__AGV_MOCK__']).toBe(devControl),
    )
    unmount()
    expect((globalThis as Record<string, unknown>)['__AGV_MOCK__']).toBeUndefined()
  })

  it('配置阶段失败为终态：保持 null 描述符且不重试', async () => {
    mockBootstrap.mockRejectedValue(
      new StructuredError({ code: 'CONFIG_HTTP_STATUS', message: '配置读取失败', context: { status: 404 } }),
    )
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
    await flush()
    expect(capture.mapDescriptor).toBeNull()
    // StrictMode 双执行（无重试）：仅两条初始调用
    expect(mockBootstrap).toHaveBeenCalledTimes(2)
  })

  it('地图阶段失败按退避自动重试直至成功', async () => {
    vi.useFakeTimers()
    const result = buildBootstrapResult()
    mockBootstrap.mockRejectedValueOnce(
      new StructuredError({ code: 'MAP_HTTP_STATUS', message: '地图 503', context: { status: 503 } }),
    )
    mockBootstrap.mockResolvedValueOnce(result)
    render(<App />)

    await flush()
    expect(capture.mapDescriptor).toBeNull()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(mockBootstrap).toHaveBeenCalledTimes(2)
    const descriptor = capture.mapDescriptor as { mapUrl: string } | null
    expect(descriptor).not.toBeNull()
    expect(descriptor!.mapUrl).toBe('http://t/json/map.json')
  })

  it('页面隐藏时 Canvas frameloop 切为 never，回前台恢复 always（§11.5；TASK-015）', () => {
    mockBootstrap.mockReturnValue(new Promise(() => {}))
    const { container, unmount } = render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
    const shell = () =>
      container.querySelector<HTMLElement>('[data-testid="canvas-shell"]')!
    expect(shell().getAttribute('data-frameloop')).toBe('always')

    // 隐藏：帧循环完全停止（useFrame 不执行、GPU 零提交），数据源照常在后台
    act(() => {
      setPageVisibility('hidden')
    })
    expect(shell().getAttribute('data-frameloop')).toBe('never')

    // 回前台：恢复帧循环，首个渲染帧消费全部积压脏标记，一帧对齐最新快照
    act(() => {
      setPageVisibility('visible')
    })
    expect(shell().getAttribute('data-frameloop')).toBe('always')
    unmount()
  })
})
