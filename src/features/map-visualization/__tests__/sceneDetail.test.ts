/*
 * 三级场景细节层级测试（视觉对齐 P0-5.1；与实现共置）。
 *
 * 职责：锁定场景等级判定与控制器的合同：
 * 1. 带迟滞的等级判定：进入与退出使用不同阈值，区间内保持当前等级；
 * 2. 对角线缩放：同一比例适用于任意尺度的地图；
 * 3. 控制器：等级跃迁时写共享 uniform 并返回新等级；无变化返回 null；
 * 4. 角色最低可见等级表覆盖全部角色且方向正确（总览最少、近景最多）。
 */
import { describe, expect, it } from 'vitest'
import {
  CLOSEUP_ENTER_DIAGONAL_RATIO,
  CLOSEUP_EXIT_DIAGONAL_RATIO,
  ROLE_MIN_SCENE_LEVEL,
  ZONE_ENTER_DIAGONAL_RATIO,
  ZONE_EXIT_DIAGONAL_RATIO,
  resolveSceneDetailLevel,
  type SceneDetailLevel,
} from '@/features/map-visualization/scene/sceneDetail'
import {
  computeCameraFocusDistance,
  createSceneDetailController,
} from '@/features/map-visualization/scene/sceneDetailController'
import type { NodeVisualRole } from '@/features/map-visualization/model/types'

const DIAGONAL = 200

describe('resolveSceneDetailLevel：带迟滞的等级判定', () => {
  it('总览 → 作业区在进入阈值内发生，退出阈值内保持总览', () => {
    const zoneEnter = ZONE_ENTER_DIAGONAL_RATIO * DIAGONAL
    expect(resolveSceneDetailLevel(0, zoneEnter - 1, DIAGONAL)).toBe(1)
    // 迟滞区间 [zoneEnter, zoneExit)：原总览保持总览
    expect(resolveSceneDetailLevel(0, zoneEnter, DIAGONAL)).toBe(0)
    // 原作业区在同一距离点保持作业区（迟滞不闪烁）
    expect(resolveSceneDetailLevel(1, zoneEnter, DIAGONAL)).toBe(1)
  })

  it('作业区 → 总览在退出阈值外发生', () => {
    const zoneExit = ZONE_EXIT_DIAGONAL_RATIO * DIAGONAL
    expect(resolveSceneDetailLevel(1, zoneExit - 1, DIAGONAL)).toBe(1)
    expect(resolveSceneDetailLevel(1, zoneExit, DIAGONAL)).toBe(0)
  })

  it('作业区 ⇄ 近景：进入与退出阈值构成迟滞区间', () => {
    const closeEnter = CLOSEUP_ENTER_DIAGONAL_RATIO * DIAGONAL
    const closeExit = CLOSEUP_EXIT_DIAGONAL_RATIO * DIAGONAL
    expect(resolveSceneDetailLevel(1, closeEnter - 1, DIAGONAL)).toBe(2)
    expect(resolveSceneDetailLevel(2, closeExit - 1, DIAGONAL)).toBe(2)
    expect(resolveSceneDetailLevel(2, closeExit, DIAGONAL)).toBe(1)
    // 迟滞区间 [closeEnter, closeExit)：原近景保持近景、原作业区保持作业区
    expect(resolveSceneDetailLevel(2, closeEnter, DIAGONAL)).toBe(2)
    expect(resolveSceneDetailLevel(1, closeEnter, DIAGONAL)).toBe(1)
  })
  it('极小对角线退化为 1m，不产生除零', () => {
    expect(resolveSceneDetailLevel(0, 0.1, 0)).toBe(1)
    expect(resolveSceneDetailLevel(0, 10, -5)).toBe(0)
  })
})

describe('createSceneDetailController：共享 uniform 状态机', () => {
  it('等级跃迁时写共享 uniform 并返回新等级；无跃迁返回 null', () => {
    const controller = createSceneDetailController(DIAGONAL)
    expect(controller.level).toBe(0)
    expect(controller.uniforms.uSceneLevel.value).toBe(0)

    const zoneEnter = ZONE_ENTER_DIAGONAL_RATIO * DIAGONAL
    expect(controller.update(zoneEnter - 1)).toBe(1)
    expect(controller.uniforms.uSceneLevel.value).toBe(1)
    // 同距离再次更新：无跃迁
    expect(controller.update(zoneEnter - 1)).toBeNull()
    expect(controller.uniforms.uSceneLevel.value).toBe(1)

    const zoneExit = ZONE_EXIT_DIAGONAL_RATIO * DIAGONAL
    expect(controller.update(zoneExit + 1)).toBe(0)
    expect(controller.uniforms.uSceneLevel.value).toBe(0)
  })
})

describe('ROLE_MIN_SCENE_LEVEL：角色可见性方向', () => {
  const ALL_ROLES: NodeVisualRole[] = [
    'route-control',
    'junction',
    'work-station',
    'storage-slot',
    'charge',
    'park',
    'landmark',
  ]

  it('覆盖全部角色', () => {
    expect(Object.keys(ROLE_MIN_SCENE_LEVEL).sort()).toEqual([...ALL_ROLES].sort())
  })

  it('route-control 与 storage-slot 仅近景可见；charge/landmark 全等级可见', () => {
    expect(ROLE_MIN_SCENE_LEVEL['route-control']).toBe(2)
    expect(ROLE_MIN_SCENE_LEVEL['storage-slot']).toBe(2)
    expect(ROLE_MIN_SCENE_LEVEL.charge).toBe(0)
    expect(ROLE_MIN_SCENE_LEVEL.landmark).toBe(0)
    expect(ROLE_MIN_SCENE_LEVEL.junction).toBe(1)
    expect(ROLE_MIN_SCENE_LEVEL['work-station']).toBe(1)
    expect(ROLE_MIN_SCENE_LEVEL.park).toBe(1)
  })

  it('等级值都在 0..2 内', () => {
    for (const level of Object.values(ROLE_MIN_SCENE_LEVEL) as SceneDetailLevel[]) {
      expect(level).toBeGreaterThanOrEqual(0)
      expect(level).toBeLessThanOrEqual(2)
    }
  })
})

describe('computeCameraFocusDistance：聚焦距离推导', () => {
  it('俯视相机返回沿视线到地面交点的距离', () => {
    const camera = {
      position: { x: 0, y: 100, z: 0 },
      getWorldDirection: (target: { x: number; y: number; z: number }) => {
        target.x = 0
        target.y = -1
        target.z = 0
        return target
      },
    } as unknown as Parameters<typeof computeCameraFocusDistance>[0]
    expect(computeCameraFocusDistance(camera)).toBeCloseTo(100, 4)
  })

  it('视线近水平时按保守俯角由高度反推有限正值', () => {
    const camera = {
      position: { x: 0, y: 50, z: 0 },
      getWorldDirection: (target: { x: number; y: number; z: number }) => {
        target.x = 1
        target.y = 0
        target.z = 0
        return target
      },
    } as unknown as Parameters<typeof computeCameraFocusDistance>[0]
    const distance = computeCameraFocusDistance(camera)
    expect(Number.isFinite(distance)).toBe(true)
    expect(distance).toBeGreaterThan(0)
  })
})
