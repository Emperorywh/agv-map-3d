import { describe, expect, it } from 'vitest'

import { useAppStore } from './appStore'

describe('appStore 骨架', () => {
  it('提供 cameraMode / selection / layers / agvSnapshot 默认值', () => {
    const state = useAppStore.getState()
    expect(state.cameraMode).toBe('orbit')
    expect(state.followAgvId).toBeNull()
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

  it('setFollowAgv 进入 / 退出跟随模式', () => {
    useAppStore.getState().setFollowAgv(7)
    expect(useAppStore.getState().cameraMode).toBe('follow')
    expect(useAppStore.getState().followAgvId).toBe(7)
    useAppStore.getState().setFollowAgv(null)
    useAppStore.getState().setCameraMode('orbit')
    expect(useAppStore.getState().followAgvId).toBeNull()
  })
})
