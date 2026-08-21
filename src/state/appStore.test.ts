import { describe, expect, it } from 'vitest'

import { useAppStore } from './appStore'

describe('appStore 骨架', () => {
  it('提供 cameraMode / followTargetId / selection / layers / agvSnapshot 默认值', () => {
    const state = useAppStore.getState()
    expect(state.cameraMode).toBe('orbit')
    expect(state.followTargetId).toBeNull()
    expect(state.selection).toBeNull()
    expect(state.layers).toEqual({
      nodes: true,
      corridors: true,
      labels: true,
      interior: true,
      groundMarkings: true,
      roof: 'auto',
    })
    expect(state.agvSnapshot).toEqual([])
  })

  it('setCameraMode 更新相机模式', () => {
    useAppStore.getState().setCameraMode('topdown')
    expect(useAppStore.getState().cameraMode).toBe('topdown')
    useAppStore.getState().setCameraMode('orbit')
  })

  it('setLayer 只更新指定图层开关', () => {
    useAppStore.getState().setLayer('labels', false)
    const { layers } = useAppStore.getState()
    expect(layers.labels).toBe(false)
    expect(layers.nodes).toBe(true)
    useAppStore.getState().setLayer('labels', true)
  })

  it('setFollowTarget 进入跟随模式并设定目标', () => {
    useAppStore.getState().setFollowTarget(7)
    expect(useAppStore.getState().cameraMode).toBe('follow')
    expect(useAppStore.getState().followTargetId).toBe(7)
    useAppStore.getState().setCameraMode('orbit')
  })

  it('setCameraMode 切出跟随时清空 followTargetId', () => {
    useAppStore.getState().setFollowTarget(3)
    useAppStore.getState().setCameraMode('orbit')
    expect(useAppStore.getState().cameraMode).toBe('orbit')
    expect(useAppStore.getState().followTargetId).toBeNull()

    useAppStore.getState().setFollowTarget(5)
    useAppStore.getState().setCameraMode('topdown')
    expect(useAppStore.getState().cameraMode).toBe('topdown')
    expect(useAppStore.getState().followTargetId).toBeNull()
    useAppStore.getState().setCameraMode('orbit')
  })

  it('setCameraMode 直接切 follow 为空操作（跟随须经 setFollowTarget 携带目标进入）', () => {
    useAppStore.getState().setCameraMode('follow')
    const state = useAppStore.getState()
    expect(state.cameraMode).toBe('orbit')
    expect(state.followTargetId).toBeNull()
  })
})
