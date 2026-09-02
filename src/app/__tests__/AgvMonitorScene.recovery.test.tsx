/*
 * AgvMonitorScene 上下文恢复结算测试（TASK-016；SPEC §11.9）。
 *
 * 职责：验证组合层的恢复编排合同——资源代经 props 下发到两个 Feature；每
 *       个资源代提交完成后恰好结算一次（子所有者 effect 先于结算 effect）；
 *       恢复期地图环境重建失败使结算为 false；资源代 0（初始挂载）不结算；
 *       StrictMode 双执行不产生重复结算。两个 Feature 以替身组件替换（jsdom
 *       无 WebGL，环境工厂默认必失败会污染结算语义），组合层接线用真实实现。
 */
import { StrictMode, useEffect } from 'react'
import { act } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import ReactThreeTestRenderer from '@react-three/test-renderer'
import { createMapModel, validateMap, type MapViewDescriptor } from '@/features/map-visualization'
import {
  createPlaneTransform,
  createWorldTransform,
  IDENTITY_AFFINE,
} from '@/shared/spatial'
import { AgvMonitorScene } from '@/app/scene/AgvMonitorScene'

/** 替身状态（vi.hoisted：vi.mock 工厂内可引用） */
const stubs = vi.hoisted(() => ({
  mapProps: [] as Array<Record<string, unknown>>,
  fleetProps: [] as Array<Record<string, unknown>>,
  /** 置位后：地图 Feature 在下一次资源代 effect 中上报重建失败 */
  failMapRecreate: { value: false },
}))

vi.mock('@/features/map-visualization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/map-visualization')>()
  return {
    ...actual,
    MapVisualizationFeature: (props: Record<string, unknown>) => {
      stubs.mapProps.push(props)
      // 模拟「环境工厂在恢复期失败」：子所有者 effect 内上报（真实实现中
      // 由 SceneLighting 的环境 effect 调用，同样先于父结算 effect）。
      // 无依赖数组：每次渲染检查旗标，与「结算只发生在资源代变化提交」配合
      useEffect(() => {
        if (stubs.failMapRecreate.value) {
          ;(props.onContextRecreateFailed as (() => void) | undefined)?.()
        }
      })
      return null
    },
  }
})

vi.mock('@/features/fleet-monitoring', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/fleet-monitoring')>()
  return {
    ...actual,
    FleetMonitoringFeature: (props: Record<string, unknown>) => {
      stubs.fleetProps.push(props)
      return null
    },
  }
})

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

/** 最小合法地图描述符（bootstrap 种子） */
function makeDescriptor(): MapViewDescriptor {
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
    mapUrl: 'http://t/map.json',
    coordinateTransform: { scale: 1, rotation: 0, mirrorY: false, translateX: 0, translateY: 0 },
    initial: { mapModel, worldTransform },
  }
}

/** 恒等世界变换：组合层只透传，替身 Feature 不消费其内容 */
const world = createWorldTransform(createPlaneTransform(IDENTITY_AFFINE), { x: 0, y: 0 })

function sceneElement(generation: number, onSettled?: (ok: boolean) => void) {
  return (
    <AgvMonitorScene
      mapDescriptor={makeDescriptor()}
      vehicleSource={null}
      worldTransform={world}
      contextGeneration={generation}
      onContextRecoverySettled={onSettled}
    />
  )
}

describe('AgvMonitorScene 上下文恢复结算（TASK-016）', () => {
  it('资源代经 props 下发到两个 Feature；代 0（初始挂载）不结算', async () => {
    stubs.mapProps = []
    stubs.fleetProps = []
    stubs.failMapRecreate.value = false
    const onSettled = vi.fn()
    const renderer = await ReactThreeTestRenderer.create(sceneElement(0, onSettled))
    try {
      await flush()
      expect(stubs.mapProps.at(-1)?.contextGeneration).toBe(0)
      expect(stubs.fleetProps.at(-1)?.contextGeneration).toBe(0)
      expect(onSettled).not.toHaveBeenCalled()
    } finally {
      renderer.unmount()
      stubs.failMapRecreate.value = false
    }
  })

  it('资源代 0→1：全部所有者重建完成后恰好结算一次成功', async () => {
    stubs.mapProps = []
    stubs.fleetProps = []
    stubs.failMapRecreate.value = false
    const onSettled = vi.fn()
    const renderer = await ReactThreeTestRenderer.create(sceneElement(0, onSettled))
    try {
      await flush()
      await act(async () => {
        await renderer.update(sceneElement(1, onSettled))
      })
      await flush()
      expect(onSettled).toHaveBeenCalledTimes(1)
      expect(onSettled).toHaveBeenNthCalledWith(1, true)
      // 下发到两个 Feature 的资源代同步递增
      expect(stubs.mapProps.at(-1)?.contextGeneration).toBe(1)
      expect(stubs.fleetProps.at(-1)?.contextGeneration).toBe(1)
    } finally {
      renderer.unmount()
      stubs.failMapRecreate.value = false
    }
  })

  it('恢复期地图环境重建失败：结算为 false（计入失败计数）；下一恢复正常后结算为 true', async () => {
    stubs.mapProps = []
    stubs.fleetProps = []
    stubs.failMapRecreate.value = false
    const onSettled = vi.fn()
    const renderer = await ReactThreeTestRenderer.create(sceneElement(0, onSettled))
    try {
      await flush()
      stubs.failMapRecreate.value = true
      await act(async () => {
        await renderer.update(sceneElement(1, onSettled))
      })
      await flush()
      expect(onSettled).toHaveBeenCalledTimes(1)
      expect(onSettled).toHaveBeenNthCalledWith(1, false)

      // 重试代：失败旗标复位后结算恢复成功（旗标绝不跨代累积）
      stubs.failMapRecreate.value = false
      await act(async () => {
        await renderer.update(sceneElement(2, onSettled))
      })
      await flush()
      expect(onSettled).toHaveBeenCalledTimes(2)
      expect(onSettled).toHaveBeenNthCalledWith(2, true)
    } finally {
      renderer.unmount()
      stubs.failMapRecreate.value = false
    }
  })

  it('StrictMode 双执行：资源代 0→1 只产生一次结算', async () => {
    stubs.mapProps = []
    stubs.fleetProps = []
    stubs.failMapRecreate.value = false
    const onSettled = vi.fn()
    const renderer = await ReactThreeTestRenderer.create(
      <StrictMode>{sceneElement(0, onSettled)}</StrictMode>,
    )
    try {
      await flush()
      await act(async () => {
        await renderer.update(<StrictMode>{sceneElement(1, onSettled)}</StrictMode>)
      })
      await flush()
      expect(onSettled).toHaveBeenCalledTimes(1)
      expect(onSettled).toHaveBeenNthCalledWith(1, true)
    } finally {
      renderer.unmount()
      stubs.failMapRecreate.value = false
    }
  })
})
