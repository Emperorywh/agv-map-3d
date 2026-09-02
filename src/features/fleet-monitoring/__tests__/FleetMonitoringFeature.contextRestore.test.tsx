/*
 * FleetMonitoringFeature 上下文恢复重建测试（TASK-016；SPEC §11.9）。
 *
 * 职责：验证资源代驱动的车队侧恢复重建合同——contextGeneration 递增时共享
 *       车体/光环几何材质整代重建（旧资源由所有权 effect 恰好释放一次），四
 *       个图层在同一提交内按「车辆 → 标签 → 环 → 交通资源」顺序整体卸载/重
 *       建（先释放全部旧资源，再挂载新资源）。图层与资源工厂以记录轨迹的替
 *       身替换，保证顺序与计数断言确定；数据保留语义由 FleetMonitoringFeature
 *       集成测试（真实图层）覆盖。
 */
import { act } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import ReactThreeTestRenderer from '@react-three/test-renderer'
import { useEffect } from 'react'
import { createPlaneTransform, createWorldTransform, IDENTITY_AFFINE, type WorldTransform } from '@/shared/spatial'
import { FleetRuntimeProvider } from '../components/FleetRuntimeProvider'
import { FleetMonitoringFeature } from '../components/FleetMonitoringFeature'

/** 重建轨迹（vi.hoisted：vi.mock 工厂内可引用） */
const trace = vi.hoisted(() => ({
  events: [] as string[],
}))

/** 生成记录挂载/卸载轨迹的图层替身（不创建任何 GPU 对象） */
function layerMock(name: string): () => null {
  return () => {
    useEffect(() => {
      trace.events.push(`mount:${name}`)
      return () => {
        trace.events.push(`cleanup:${name}`)
      }
    }, [])
    return null
  }
}

vi.mock('../components/VehicleInstances', () => ({ VehicleInstances: layerMock('vehicles') }))
vi.mock('../components/VehicleLabels', () => ({ VehicleLabels: layerMock('labels') }))
vi.mock('../components/VehicleRings', () => ({ VehicleRings: layerMock('rings') }))
vi.mock('../components/TrafficLocksLayer', () => ({ TrafficLocksLayer: layerMock('traffic') }))

/** 包裹真实资源工厂：记录创建与释放轨迹（释放仍委托真实实现） */
vi.mock('../scene/createVehicleGeometry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../scene/createVehicleGeometry')>()
  return {
    ...actual,
    createVehicleResources: () => {
      const real = actual.createVehicleResources()
      trace.events.push('create:vehicle-resources')
      return {
        ...real,
        dispose: () => {
          trace.events.push('dispose:vehicle-resources')
          real.dispose()
        },
      }
    },
  }
})

vi.mock('../scene/vehicleRings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../scene/vehicleRings')>()
  return {
    ...actual,
    createRingResources: () => {
      const real = actual.createRingResources()
      trace.events.push('create:ring-resources')
      return {
        ...real,
        dispose: () => {
          trace.events.push('dispose:ring-resources')
          real.dispose()
        },
      }
    },
  }
})

function makeWorld(): WorldTransform {
  return createWorldTransform(createPlaneTransform(IDENTITY_AFFINE), { x: 100, y: 50 })
}

describe('FleetMonitoringFeature 上下文恢复重建（TASK-016）', () => {
  it('资源代递增：共享资源整代重建（旧资源恰好释放一次），四图层按 车辆→标签→环→交通 顺序重建', async () => {
    trace.events.length = 0
    const renderer = await ReactThreeTestRenderer.create(
      <FleetRuntimeProvider source={null}>
        <FleetMonitoringFeature worldTransform={makeWorld()} contextGeneration={0} />
      </FleetRuntimeProvider>,
    )
    try {
      await act(async () => {})
      // 初始挂载：共享资源在渲染阶段创建，图层按 JSX 顺序落地
      expect(trace.events).toEqual([
        'create:vehicle-resources',
        'create:ring-resources',
        'mount:vehicles',
        'mount:labels',
        'mount:rings',
        'mount:traffic',
      ])
      trace.events.length = 0

      // 资源代递增：新资源在渲染阶段创建；提交阶段先释放全部旧资源
      // （子图层清理在前、父共享资源释放在后），再挂载新图层
      await act(async () => {
        await renderer.update(
          <FleetRuntimeProvider source={null}>
            <FleetMonitoringFeature worldTransform={makeWorld()} contextGeneration={1} />
          </FleetRuntimeProvider>,
        )
      })
      expect(trace.events).toEqual([
        'create:vehicle-resources',
        'create:ring-resources',
        'cleanup:vehicles',
        'cleanup:labels',
        'cleanup:rings',
        'cleanup:traffic',
        'dispose:vehicle-resources',
        'dispose:ring-resources',
        'mount:vehicles',
        'mount:labels',
        'mount:rings',
        'mount:traffic',
      ])

      // 再换代一次：释放计数同步为 2（重复换代幂等，无泄漏）
      trace.events.length = 0
      await act(async () => {
        await renderer.update(
          <FleetRuntimeProvider source={null}>
            <FleetMonitoringFeature worldTransform={makeWorld()} contextGeneration={2} />
          </FleetRuntimeProvider>,
        )
      })
      expect(trace.events.filter((event) => event === 'dispose:vehicle-resources')).toHaveLength(1)
      expect(trace.events.filter((event) => event === 'dispose:ring-resources')).toHaveLength(1)
    } finally {
      renderer.unmount()
    }
  })

  it('worldTransform=null（地图未就绪）：资源代递增不挂载任何图层，共享资源仍整代重建', async () => {
    trace.events.length = 0
    const renderer = await ReactThreeTestRenderer.create(
      <FleetRuntimeProvider source={null}>
        <FleetMonitoringFeature worldTransform={null} contextGeneration={0} />
      </FleetRuntimeProvider>,
    )
    try {
      await act(async () => {})
      // 未就绪时资源照常创建（生命周期恒定），图层不挂载（不变量 3）
      expect(trace.events).toEqual(['create:vehicle-resources', 'create:ring-resources'])
      trace.events.length = 0

      await act(async () => {
        await renderer.update(<FleetRuntimeProvider source={null}>
          <FleetMonitoringFeature worldTransform={null} contextGeneration={1} />
        </FleetRuntimeProvider>)
      })
      // 无图层可释放/挂载；共享资源换代照常（新代资源等待地图就绪后消费）
      expect(trace.events).toEqual([
        'create:vehicle-resources',
        'create:ring-resources',
        'dispose:vehicle-resources',
        'dispose:ring-resources',
      ])
    } finally {
      renderer.unmount()
    }
  })
})
