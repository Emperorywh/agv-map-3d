/**
 * 工业地坪图层（SPEC §5.1 地面行；TASK-004；P1-2/P1-3 视觉差距修订）。
 *
 * 职责：按地图世界包围盒加 50m 边距一次生成工业地坪平面（MeshStandardMaterial
 *       接收阴影 + 5m 平铺的细纹 Canvas 贴图），以静态 Group 挂入场景。
 *       此前的 5m LineBasicMaterial 网格刻线在总览呈「方格纸」、近景却因
 *       1px 不可见（视觉差距分析 P1-2），改贴图后总览被 mipmap 均化为近纯
 *       色、近景露出 1m 细线 + 5m 分缝的低对比工业地坪纹理。
 * 边界：只消费 SceneBounds 纯数据；几何、材质与贴图在本组件内创建并在卸载
 *       时释放（R3F 对 primitive 传入的外部对象不做释放，资源所有权归本组
 *       件）。Canvas 2D 不可得（无头测试环境）时降级为无贴图纯色地坪。
 * 关键不变量：
 * 1. 地坪尺寸 = (包围盒跨度 + 2×边距)，中心对齐包围盒中心，一次生成不重建；
 * 2. bounds 变化（地图原子替换）时 useMemo 重建新对象，旧对象在其 effect
 *    清理中整体释放，任何时刻场景内只有一份地坪；
 * 3. 贴图为低对比乘色（细线 ×0.93、分缝 ×0.86），RepeatWrapping 平铺且
 *    一格恰为 GROUND_TILE_M 米——纹理密度与世界尺度恒定。
 */
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import type { SceneBounds } from '../model/types'
import {
  GROUND_COLOR,
  GROUND_FINE_LINE_SPACING_M,
  GROUND_FINE_LINE_STRENGTH,
  GROUND_MARGIN_M,
  GROUND_METALNESS,
  GROUND_ROUGHNESS,
  GROUND_SEAM_STRENGTH,
  GROUND_TILE_M,
  GROUND_TILE_TEXTURE_PX,
  GROUND_Y,
} from '../scene/mapAppearance'

/** 构建地坪平面（含细纹贴图）的静态组合对象 */
function createGroundObject(bounds: SceneBounds): THREE.Group {
  const group = new THREE.Group()
  group.name = 'map-ground'
  group.matrixAutoUpdate = false

  const spanX = bounds.maxWorldX - bounds.minWorldX + GROUND_MARGIN_M * 2
  const spanZ = bounds.maxWorldZ - bounds.minWorldZ + GROUND_MARGIN_M * 2

  const planeGeometry = new THREE.PlaneGeometry(spanX, spanZ)
  // 平面几何默认在 XY 面，旋转到 XZ 地面
  planeGeometry.rotateX(-Math.PI / 2)
  const planeMaterial = new THREE.MeshStandardMaterial({
    color: GROUND_COLOR,
    roughness: GROUND_ROUGHNESS,
    metalness: GROUND_METALNESS,
  })
  const texture = createGroundTileTexture()
  if (texture !== null) {
    // 一格 = GROUND_TILE_M 米：贴图密度锚定世界尺度；Repeat 平铺整张地坪
    texture.repeat.set(spanX / GROUND_TILE_M, spanZ / GROUND_TILE_M)
    planeMaterial.map = texture
  }
  const plane = new THREE.Mesh(planeGeometry, planeMaterial)
  plane.position.set(bounds.centerWorldX, GROUND_Y, bounds.centerWorldZ)
  plane.receiveShadow = true
  plane.matrixAutoUpdate = false
  plane.updateMatrix()
  group.add(plane)

  group.updateMatrix()
  return group
}

/**
 * 5m 平铺地坪贴图：白底（乘色 = 地坪原色），1m 细线（×0.93 乘数）与格边
 * 5m 分缝（×0.86）。Canvas 不可用时返回 null（纯色地坪降级，不阻断挂载）。
 */
function createGroundTileTexture(): THREE.CanvasTexture | null {
  const canvas = document.createElement('canvas')
  canvas.width = GROUND_TILE_TEXTURE_PX
  canvas.height = GROUND_TILE_TEXTURE_PX
  const ctx = canvas.getContext('2d')
  if (ctx === null) {
    return null
  }
  const size = GROUND_TILE_TEXTURE_PX
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, size, size)

  const toGray = (strength: number): string => {
    const v = Math.round(255 * strength)
    return `rgb(${v}, ${v}, ${v})`
  }
  // 1m 细线：GROUND_TILE_M 米格里每 GROUND_FINE_LINE_SPACING_M 米一条
  const fineStep = (size / GROUND_TILE_M) * GROUND_FINE_LINE_SPACING_M
  ctx.strokeStyle = toGray(GROUND_FINE_LINE_STRENGTH)
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let p = fineStep; p < size - 0.5; p += fineStep) {
    ctx.moveTo(p, 0)
    ctx.lineTo(p, size)
    ctx.moveTo(0, p)
    ctx.lineTo(size, p)
  }
  ctx.stroke()
  // 5m 分缝：画在格边（x=0 / y=0，平铺后即每格边界）
  ctx.strokeStyle = toGray(GROUND_SEAM_STRENGTH)
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(0.5, 0)
  ctx.lineTo(0.5, size)
  ctx.moveTo(0, 0.5)
  ctx.lineTo(size, 0.5)
  ctx.stroke()

  const texture = new THREE.CanvasTexture(canvas)
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  return texture
}

/** 释放地坪组合对象创建的全部 geometry 与材质（含贴图，不含外部传入资源） */
function disposeGroundObject(group: THREE.Group): void {
  group.traverse((child) => {
    const mesh = child as THREE.Mesh
    mesh.geometry?.dispose()
    const material = (mesh as unknown as { material?: THREE.Material | THREE.Material[] })
      .material
    for (const item of Array.isArray(material) ? material : [material]) {
      if (item === undefined) {
        continue
      }
      const standard = item as THREE.MeshStandardMaterial
      standard.map?.dispose()
      item.dispose()
    }
  })
}

export function GroundLayer({ bounds }: GroundLayerProps) {
  const group = useMemo(() => createGroundObject(bounds), [bounds])
  useEffect(() => () => disposeGroundObject(group), [group])
  // dispose={null}：对象由本组件显式拥有与释放，禁止 R3F 卸载时二次释放
  return <primitive object={group} dispose={null} />
}

interface GroundLayerProps {
  bounds: SceneBounds
}
