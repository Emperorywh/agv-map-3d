/**
 * 工业资产共用的几何拼装工具，尺寸统一为米，默认车头朝本地正 X。
 * 临时几何在合并后立即释放，合并结果由使用方统一管理生命周期。
 */
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

export function industrialBox(x: number, y: number, z: number, radius = 0.006, segments = 2): THREE.BufferGeometry {
  return new RoundedBoxGeometry(x, y, z, segments, Math.min(radius, x / 4, y / 4, z / 4))
}

export function joinGeometry(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const result = mergeGeometries(parts, false)
  for (const part of parts) part.dispose()
  if (result === null) throw new Error('工业资产几何属性不兼容')
  result.computeBoundingBox()
  result.computeBoundingSphere()
  return result
}

/**
 * 托盘归一化到单位包围盒，底面为负二分之一；实例矩阵提供实际载荷尺寸。
 * 五根面板、三根底板和九个垫块形成真实叉孔，避免实心木块外观。
 */
export function createPalletGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  for (let i = 0; i < 5; i += 1) {
    parts.push(industrialBox(1, 0.22, 0.16).translate(0, 0.39, -0.42 + i * 0.21))
  }
  /**
   * 底部承重板略向内收，使标准载荷托盘的支撑落在精修平台有效宽度内。
   * 上层面板保留载荷宽度及合理悬挑，不与高出平台八毫米的外壳上沿穿插。
   */
  for (const z of [-0.34, 0, 0.34]) {
    parts.push(industrialBox(1, 0.18, 0.19).translate(0, -0.41, z))
    for (const x of [-0.4, 0, 0.4]) {
      parts.push(industrialBox(0.18, 0.6, 0.19).translate(x, -0.02, z))
    }
  }
  return joinGeometry(parts)
}

/**
 * 两只纸箱共用一份纸板几何，封口胶带单独合批但与箱体使用相同实例矩阵。
 * 所有箱底位于负二分之一，保证不同载荷尺寸下始终接触托盘面。
 */
export function createCartonGeometry(tape = false): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  for (const [x, width, height, depth] of [[-0.18, 0.61, 1, 0.94], [0.32, 0.33, 0.72, 0.86]]) {
    if (tape) {
      parts.push(industrialBox(width + 0.003, 0.008, 0.10, 0.001).translate(x, height - 0.498, 0))
      for (const side of [-1, 1]) {
        parts.push(industrialBox(0.004, height * 0.32, 0.10, 0.001).translate(x + side * width / 2, height * 0.84 - 0.5, 0))
      }
    } else {
      parts.push(industrialBox(width, height - 0.018, depth, 0.007).translate(x, (height - 0.018) / 2 - 0.5, 0))
      for (const side of [-1, 1]) {
        parts.push(industrialBox(width, 0.016, depth / 2 - 0.006, 0.002).translate(x, height - 0.508, side * depth / 4))
      }
    }
  }
  return joinGeometry(parts)
}
