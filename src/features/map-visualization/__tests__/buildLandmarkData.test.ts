/*
 * 地标实例数据构建测试（与实现共置；TASK-005；P0-5 移除仓库名称锚点；
 * P2-2 停车点拆分为凸起 slab + 光晕数据）。
 *
 * 职责：锁定 buildLandmarkData 的纯数据合同（当前夹具）：
 * 1. 数量恒等：立柱/光环/呼吸灯矩阵数 = charge 节点数；仓库方垫数 =
 *    warehouse 节点数；停车 slab/光晕数 = park 数 = 停车字形锚点数；
 *    仓库名称锚点恒为不存在（P0-5）；
 * 2. 位置恒等：全部世界坐标与 WorldTransform.toWorldXZ 一致（§2.5 同源）；
 * 3. 方垫缩放与实例颜色：仓库浅黄，颜色表与 warehousePadColors 数值一致；
 *    停车 slab 为平移+xz/板厚非等比缩放（P2-2）；
 * 4. work/unknown 节点不产生任何地标语义。
 */
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { createMapModel } from '../model/createMapModel'
import { validateMap } from '../model/validateMap'
import { buildLandmarkData } from '../scene/buildLandmarkData'
import {
  NODE_COLORS,
  PARK_PAD_SIZE_M,
  PARK_SLAB_HALO_SIZE_RATIO,
  PARK_SLAB_HEIGHT_M,
  WAREHOUSE_PAD_SIZE_M,
} from '../scene/mapAppearance'
import { makeNode } from './fixtures'

function buildFixture() {
  const model = createMapModel(
    validateMap({
      nodes: [
        makeNode({ id: 'a', name: 'A', type: 'work', x: 0, y: 0 }),
        makeNode({ id: 'c1', name: '充电1', type: 'charge', x: 3, y: 4 }),
        makeNode({ id: 'w1', name: 'AMR-PICK001', type: 'warehouse', x: 8, y: 0 }),
        makeNode({ id: 'p1', name: '847', type: 'park', x: 12, y: -2 }),
        makeNode({ id: 'u1', name: '未知站', type: 'weird', x: 7, y: 7 }),
      ],
      edges: [],
      zones: [],
      nodeEdgeGroups: [],
    }),
  )
  return { ...model, mapModel: model.mapModel }
}

describe('buildLandmarkData 地标实例数据', () => {
  const { mapModel, worldTransform } = buildFixture()
  const data = buildLandmarkData(mapModel, worldTransform)

  it('数量恒等：charge 1 组矩阵、仓库方垫 1 个、停车 slab/光晕 1 个、停车锚点 1 个', () => {
    expect(data.chargeCount).toBe(1)
    expect(data.chargeMatrices).toHaveLength(16)
    expect(data.warehousePadCount).toBe(1)
    expect(data.warehousePadMatrices).toHaveLength(16)
    expect(data.warehousePadColors).toHaveLength(3)
    expect(data.parkSlabCount).toBe(1)
    expect(data.parkSlabMatrices).toHaveLength(16)
    expect(data.parkHaloMatrices).toHaveLength(16)
    expect(data.parkAnchors).toHaveLength(1)
  })

  it('P0-5：仓库名称锚点已整体移除（名称只保留在独占区/停车字形）', () => {
    expect('warehouseNameAnchors' in data).toBe(false)
  })

  it('位置与世界坐标同源：立柱平移与停车锚点均来自统一 WorldTransform', () => {
    const charge = mapModel.nodes.get('c1')!
    const chargeWorld = worldTransform.toWorldXZ(charge.x, charge.y)
    expect(data.chargeMatrices[12]).toBeCloseTo(chargeWorld.x, 5)
    expect(data.chargeMatrices[13]).toBeCloseTo(0, 5)
    expect(data.chargeMatrices[14]).toBeCloseTo(chargeWorld.z, 5)

    const park = mapModel.nodes.get('p1')!
    const parkWorld = worldTransform.toWorldXZ(park.x, park.y)
    expect(data.parkAnchors[0]).toMatchObject({ nodeId: 'p1', x: parkWorld.x, z: parkWorld.z })
  })

  it('仓库方垫按类别缩放与着色（浅黄），矩阵为平移+等比 xz 缩放', () => {
    const expectedWarehouse = new THREE.Color(NODE_COLORS.warehouse)

    expect(data.warehousePadMatrices[0]).toBeCloseTo(WAREHOUSE_PAD_SIZE_M, 5)
    expect(data.warehousePadMatrices[5]).toBeCloseTo(1, 5)
    expect(data.warehousePadMatrices[10]).toBeCloseTo(WAREHOUSE_PAD_SIZE_M, 5)
    expect(data.warehousePadColors[0]).toBeCloseTo(expectedWarehouse.r, 5)
    expect(data.warehousePadColors[1]).toBeCloseTo(expectedWarehouse.g, 5)
    expect(data.warehousePadColors[2]).toBeCloseTo(expectedWarehouse.b, 5)
  })

  it('P2-2：停车 slab 为平移+xz/板厚非等比缩放，光晕随动放大', () => {
    // slab：足迹 = PARK_PAD_SIZE_M，y 缩放 = 板厚，基线在地面（y 平移 0）
    expect(data.parkSlabMatrices[0]).toBeCloseTo(PARK_PAD_SIZE_M, 5)
    expect(data.parkSlabMatrices[5]).toBeCloseTo(PARK_SLAB_HEIGHT_M, 5)
    expect(data.parkSlabMatrices[10]).toBeCloseTo(PARK_PAD_SIZE_M, 5)
    expect(data.parkSlabMatrices[13]).toBeCloseTo(0, 5)

    // 光晕：足迹 = PARK_PAD_SIZE_M × 光晕比例
    expect(data.parkHaloMatrices[0]).toBeCloseTo(PARK_PAD_SIZE_M * PARK_SLAB_HALO_SIZE_RATIO, 5)
    expect(data.parkHaloMatrices[10]).toBeCloseTo(PARK_PAD_SIZE_M * PARK_SLAB_HALO_SIZE_RATIO, 5)
  })

  it('work 与 unknown 节点不产生地标语义（未知类型只由节点层灰色兜底）', () => {
    expect(data.warehousePadCount).toBe(1)
    expect(data.chargeCount).toBe(1)
    expect(data.parkSlabCount).toBe(1)
  })
})
