/*
 * 低频相机镜头状态 Store 测试（TASK-013 / SPEC §4）。
 *
 * 职责：锁定跟随实体键的低频写入口径——幂等写入、清除与键编码无关性。
 * 边界：纯 store 测试；逐帧跟随数据不在此处也绝不进入本 store。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { useCameraNavigationStore } from '../model/cameraNavigationStore'

describe('cameraNavigationStore 低频镜头状态', () => {
  beforeEach(() => {
    useCameraNavigationStore.getState().setFollowedEntityKey(null)
  })

  it('进入与切换跟随写入实体键，退出清空', () => {
    const store = useCameraNavigationStore.getState()
    store.setFollowedEntityKey('map-1|agv-1')
    expect(useCameraNavigationStore.getState().followedEntityKey).toBe(
      'map-1|agv-1',
    )
    store.setFollowedEntityKey('map-1|agv-2')
    expect(useCameraNavigationStore.getState().followedEntityKey).toBe(
      'map-1|agv-2',
    )
    store.setFollowedEntityKey(null)
    expect(useCameraNavigationStore.getState().followedEntityKey).toBeNull()
  })

  it('重复写入同一键是 no-op（不更换状态引用）', () => {
    const store = useCameraNavigationStore.getState()
    store.setFollowedEntityKey('map-1|agv-1')
    const afterFirst = useCameraNavigationStore.getState()
    store.setFollowedEntityKey('map-1|agv-1')
    expect(useCameraNavigationStore.getState()).toBe(afterFirst)
  })
})
