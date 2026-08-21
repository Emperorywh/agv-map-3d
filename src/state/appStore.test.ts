import { describe, expect, it } from 'vitest'

import { sameSelectionTarget, useAppStore } from './appStore'

describe('appStore 骨架', () => {
  it('提供 cameraMode / followTargetId / selection / hover / layers / agvSnapshot 默认值', () => {
    const state = useAppStore.getState()
    expect(state.cameraMode).toBe('orbit')
    expect(state.followTargetId).toBeNull()
    expect(state.selection).toBeNull()
    expect(state.hover).toBeNull()
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

describe('拾取选中 / 悬停（SPEC §8.2）', () => {
  it('sameSelectionTarget 按 kind + id 判定，null 两侧等价', () => {
    expect(sameSelectionTarget(null, null)).toBe(true)
    expect(sameSelectionTarget({ kind: 'node', id: 'n1' }, { kind: 'node', id: 'n1' })).toBe(true)
    expect(sameSelectionTarget({ kind: 'node', id: 'n1' }, { kind: 'node', id: 'n2' })).toBe(false)
    expect(sameSelectionTarget({ kind: 'node', id: 'n1' }, { kind: 'corridor', id: 'n1' })).toBe(
      false,
    )
    expect(sameSelectionTarget({ kind: 'node', id: 'n1' }, null)).toBe(false)
    expect(sameSelectionTarget(null, { kind: 'agv', id: '1' })).toBe(false)
  })

  it('setSelection 设定 / 清除选中，同值重设为空操作（保持引用不变）', () => {
    const target = { kind: 'node' as const, id: 'n1' }
    useAppStore.getState().setSelection(target)
    const selected = useAppStore.getState().selection
    expect(selected).toEqual(target)
    useAppStore.getState().setSelection({ kind: 'node', id: 'n1' })
    expect(useAppStore.getState().selection).toBe(selected)
    useAppStore.getState().setSelection(null)
    expect(useAppStore.getState().selection).toBeNull()
  })

  it('setHover 设定悬停，同值重设为空操作（保持引用不变）', () => {
    useAppStore.getState().setHover({ kind: 'corridor', id: 'c:1|2' })
    const hovered = useAppStore.getState().hover
    expect(hovered).toEqual({ kind: 'corridor', id: 'c:1|2' })
    useAppStore.getState().setHover({ kind: 'corridor', id: 'c:1|2' })
    expect(useAppStore.getState().hover).toBe(hovered)
    useAppStore.getState().setHover(null)
    expect(useAppStore.getState().hover).toBeNull()
  })

  it('clearHover 仅清除匹配的悬停目标（乱序 pointerout 不清掉新目标）', () => {
    useAppStore.getState().setHover({ kind: 'node', id: 'n1' })
    // 旧目标的 pointerout 迟到：不匹配，当前悬停保留
    useAppStore.getState().clearHover({ kind: 'corridor', id: 'c:1|2' })
    expect(useAppStore.getState().hover).toEqual({ kind: 'node', id: 'n1' })
    // 匹配的 pointerout：清除
    useAppStore.getState().clearHover({ kind: 'node', id: 'n1' })
    expect(useAppStore.getState().hover).toBeNull()
    // 悬停已为 null 时清除为空操作
    useAppStore.getState().clearHover({ kind: 'node', id: 'n1' })
    expect(useAppStore.getState().hover).toBeNull()
  })
})
