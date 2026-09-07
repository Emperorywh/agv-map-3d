/**
 * 充电塔异步加载与地图资源代同生共灭，模型就绪后一次性挂入全部停靠位置。
 * 卸载后才完成的加载立即释放，严格模式和上下文重建不会残留旧塔或旧灯光。
 */
import { useEffect, useRef, useState } from 'react'
import { Html } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import type * as THREE from 'three'
import { loadChargingTowers } from '../scene/chargingTowerModel'
import { useRenderQuality } from '@/shared/rendering/renderQuality'

export function ChargingTowersLayer({ matrices }: { matrices: Float32Array }) {
  const quality = useRenderQuality()
  const root = useRef<THREE.Group>(null)
  const resourceRef = useRef<Awaited<ReturnType<typeof loadChargingTowers>> | null>(null)
  const [failure, setFailure] = useState<{ matrices: Float32Array; message: string } | null>(null)
  useEffect(() => {
    if (matrices.length === 0) return
    const parent = root.current
    let active = true
    let resource: Awaited<ReturnType<typeof loadChargingTowers>> | null = null
    void loadChargingTowers(matrices, quality.pointLights).then((loaded) => {
      if (!active) { loaded.dispose(); return }
      resource = loaded
      resourceRef.current = loaded
      parent?.add(loaded.group)
    }).catch((error: unknown) => {
      if (!active) return
      const message = error instanceof Error ? error.message : String(error)
      console.error('充电塔模型加载失败', error)
      setFailure({ matrices, message })
    })
    return () => {
      active = false
      if (resourceRef.current === resource) resourceRef.current = null
      if (resource !== null) parent?.remove(resource.group)
      resource?.dispose()
    }
  }, [matrices, quality])

  /**
   * 相机移动时只更新实时灯的影响范围判定，不重建模型或提交 React 状态。
   * 实体与水晶的剔除分别由合批对象和原生网格按每次绘制相机处理。
   */
  useFrame(({ camera }) => resourceRef.current?.updateLightVisibility(camera))

  return <group ref={root} dispose={null}>
    {/* 加载失败明确显示原因，避免在设施缺失时仍让使用者误认为完整加载。
        提示不接管鼠标操作，地图导航和车辆交互仍可继续使用。 */}
    {failure?.matrices === matrices ? <Html fullscreen style={{ pointerEvents: 'none' }}>
      <p role="alert">充电塔加载失败：{failure.message}。请检查模型资源后刷新页面。</p>
    </Html> : null}
  </group>
}
