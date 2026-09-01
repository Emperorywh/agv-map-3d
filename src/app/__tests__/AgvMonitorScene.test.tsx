/*
 * AgvMonitorScene 场景组合测试（与实现共置）。
 *
 * 职责：用 @react-three/test-renderer 在不依赖真实 WebGL 的前提下，校验
 *       Canvas 内唯一组合根的场景图内容（TASK-004 接入地图 Feature 后）。
 * 关键不变量（F3 / F4 / §11.10）：
 * 1. 唯一组合锚点 agv-monitor-scene：StrictMode 双执行与更新不产生重复或残留；
 * 2. 无地图描述符时场景内无任何地图对象（首次失败保持清屏色）；
 * 3. 携带 bootstrap 种子描述符时，地图静态图层（地坪/路径/节点）就位且唯一；
 * 4. 本组件只做组合：不自行解析描述符以外的任何业务状态。
 * 注意：test-renderer 的容器在 unmount 后即失效，完整生命周期断言必须在
 * 单个用例内完成。环境工厂默认实现需要真实 WebGL，测试中经 catch 降级为
 * 无 IBL，不影响场景结构断言。
 */
import { StrictMode } from 'react'
import { act } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ReactThreeTest } from '@react-three/test-renderer'
import ReactThreeTestRenderer from '@react-three/test-renderer'
import { AgvMonitorScene } from '@/app/scene/AgvMonitorScene'
import {
  createMapModel,
  validateMap,
  type MapViewDescriptor,
} from '@/features/map-visualization'

const ANCHOR_NAME = 'agv-monitor-scene'

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

type TestInstance = ReactThreeTest.ReactThreeTestInstance

function findByName(
  scene: { findAll: (cb: (node: TestInstance) => boolean) => TestInstance[] },
  name: string,
): TestInstance[] {
  return scene.findAll((node) => node.instance.name === name)
}

/** 最小合法地图（公开入口建模），作为场景描述符的 bootstrap 种子 */
function buildSeedDescriptor(): MapViewDescriptor {
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

describe('AgvMonitorScene 场景组合根', () => {
  it('无描述符：唯一锚点、无地图对象（保持清屏色），更新不残留', async () => {
    const renderer = await ReactThreeTestRenderer.create(
      <StrictMode>
        <AgvMonitorScene />
      </StrictMode>,
    )

    expect(renderer.scene.findAllByProps({ name: ANCHOR_NAME })).toHaveLength(1)
    expect(findByName(renderer.scene, 'map-ground')).toHaveLength(0)
    expect(findByName(renderer.scene, 'map-path-surface')).toHaveLength(0)
    expect(findByName(renderer.scene, 'map-nodes')).toHaveLength(0)

    await renderer.update(
      <StrictMode>
        <AgvMonitorScene />
      </StrictMode>,
    )
    expect(renderer.scene.findAllByProps({ name: ANCHOR_NAME })).toHaveLength(1)
    expect(findByName(renderer.scene, 'map-ground')).toHaveLength(0)
    renderer.unmount()
  })

  it('携带种子描述符：地图静态图层就位且唯一，StrictMode 无重复', async () => {
    const renderer = await ReactThreeTestRenderer.create(
      <StrictMode>
        <AgvMonitorScene mapDescriptor={buildSeedDescriptor()} />
      </StrictMode>,
    )
    await flush()

    expect(renderer.scene.findAllByProps({ name: ANCHOR_NAME })).toHaveLength(1)
    expect(findByName(renderer.scene, 'map-ground')).toHaveLength(1)
    expect(findByName(renderer.scene, 'map-path-surface')).toHaveLength(1)
    expect(findByName(renderer.scene, 'map-path-centerline')).toHaveLength(1)

    const nodes = findByName(renderer.scene, 'map-nodes')
    expect(nodes).toHaveLength(1)
    const nodesMesh = nodes[0].instance as unknown as {
      isInstancedMesh: boolean
      count: number
    }
    expect(nodesMesh.isInstancedMesh).toBe(true)
    expect(nodesMesh.count).toBe(2)
    renderer.unmount()
  })
})
