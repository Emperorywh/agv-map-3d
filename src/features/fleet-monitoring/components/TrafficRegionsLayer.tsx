/**
 * 交管图层读取车队最新版本，按推送节奏提交变化，不把高频矩形放入 React 状态。
 * 使用独立版本观察，不消费车体专用脏集合；能量动画仅逐帧写共享着色器时间。
 */
import { useEffect, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import type { Group } from 'three'
import type { WorldTransform } from '@/shared/spatial'
import type { FleetRuntime } from '../model/createFleetRuntime'
import { createTrafficRegions, type TrafficRegions } from '../scene/trafficRegions'

interface TrafficRegionsLayerProps {
  readonly runtime: FleetRuntime
  readonly worldTransform: WorldTransform
}

export function TrafficRegionsLayer({ runtime, worldTransform }: TrafficRegionsLayerProps) {
  const rootRef = useRef<Group>(null)
  const resourcesRef = useRef<TrafficRegions | null>(null)
  const lastRevisionRef = useRef(-1)
  const reducedMotionRef = useRef(false)

  /**
   * 跟随系统减少动态效果偏好，切换后保留能量场静态外观和实时路权更新。
   * 监听只改变引用，不重建区域资源，也不让动画时间进入 React 状态。
   */
  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
    const syncPreference = () => { reducedMotionRef.current = preference.matches }
    syncPreference()
    preference.addEventListener('change', syncPreference)
    return () => preference.removeEventListener('change', syncPreference)
  }, [])

  /**
   * 在提交阶段创建并挂载资源，严格模式重入、世界变换替换和上下文恢复均成对释放。
   * 变换变化时重新创建空批次，使相同矩形也使用新的地图原点重新投影。
   */
  useEffect(() => {
    const root = rootRef.current
    if (root === null) return
    const resources = createTrafficRegions()
    root.add(resources.group)
    resourcesRef.current = resources
    lastRevisionRef.current = -1
    return () => {
      root.remove(resources.group)
      resources.dispose()
      resourcesRef.current = null
    }
  }, [runtime, worldTransform])

  /**
   * 路权不变时只推进着色器时间；版本变化才重建几何，稳定推送也不打断流光相位。
   * 删除、清空与恢复均读取当前实体表收敛，不保留过时标记或播放旧状态的过渡动画。
   */
  useFrame((_, delta) => {
    const resources = resourcesRef.current
    if (resources === null) return
    if (lastRevisionRef.current !== runtime.revision) {
      resources.sync(runtime.entities(), worldTransform)
      lastRevisionRef.current = runtime.revision
    }
    resources.animate(delta, reducedMotionRef.current)
  })

  return <group ref={rootRef} name="traffic-regions-layer" />
}
