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
    }: {
      style?: React.CSSProperties
      children?: React.ReactNode
    }) => (
      <div data-testid="canvas-shell" style={style}>
        <canvas />
        {children}
      </div>
    ),
  }
})

/** 捕获传给地图 Feature 的描述符（vi.hoisted 保证工厂内可引用） */
const capture = vi.hoisted(() => ({
  mapDescriptor: undefined as unknown,
}))

vi.mock('@/features/map-visualization', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/features/map-visualization')>()
  return {
    ...actual,
    MapVisualizationFeature: (props: { map: unknown }) => {
      capture.mapDescriptor = props.map
      return <div data-testid="map-feature" />
    },
  }
})

vi.mock('@/app/bootstrap/bootstrapApplication', () => ({
  bootstrapApplication: vi.fn(),
}))

const mockBootstrap = vi.mocked(bootstrapApplication)

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
})
