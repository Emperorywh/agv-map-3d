/**
 * 节点语义图标采用原生二维几何，统一在 XY 平面绘制，正 Y 为图标上方。
 * 节点顶面与充电柜标识复用同一图形，无字体、贴图请求和逐节点资源开销。
 */
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { NodeCategory } from '../model/types'
import { NODE_SYMBOL_STROKE } from './mapAppearance'

type Point = readonly [number, number]

/**
 * 用闭合路径生成实心符号，线段也转成面，避免 WebGL 线宽随设备变化。
 * 所有符号都限制在单位标识范围内，实际米制缩放由使用方负责。
 */
function polygon(points: readonly Point[]): THREE.BufferGeometry {
  return new THREE.ShapeGeometry(new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y))))
}

export function createNodeSymbolGeometry(category: NodeCategory): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const line = (points: readonly Point[], closed = false): void => {
    const count = closed ? points.length : points.length - 1
    for (let i = 0; i < count; i += 1) {
      const [ax, ay] = points[i]
      const [bx, by] = points[(i + 1) % points.length]
      const geometry = new THREE.PlaneGeometry(Math.hypot(bx - ax, by - ay), NODE_SYMBOL_STROKE)
      geometry.rotateZ(Math.atan2(by - ay, bx - ax))
      geometry.translate((ax + bx) / 2, (ay + by) / 2, 0)
      parts.push(geometry)
    }
    for (const [x, y] of points) {
      parts.push(new THREE.CircleGeometry(NODE_SYMBOL_STROKE / 2, 8).translate(x, y, 0))
    }
  }

  /**
   * 普通点用圆心定位；工作站用台面及工件；停靠用通用 P 字标。
   * 充电用实心闪电，库区用立体箱体，未知类型用问号且不冒充普通点。
   */
  switch (category) {
    case 'node':
      parts.push(new THREE.RingGeometry(0.49, 0.63, 32), new THREE.CircleGeometry(0.2, 20))
      break
    case 'work':
      line([[-0.75, 0], [0.75, 0]])
      line([[-0.58, 0], [-0.58, -0.62]])
      line([[0.58, 0], [0.58, -0.62]])
      line([[-0.35, 0.22], [-0.35, 0.67], [0.35, 0.67], [0.35, 0.22]], true)
      break
    case 'park':
      line([[-0.4, -0.7], [-0.4, 0.7], [0.22, 0.7], [0.47, 0.49], [0.47, 0.16], [0.22, -0.04], [-0.4, -0.04]])
      break
    case 'charge':
      parts.push(polygon([[0.12, 0.88], [-0.57, -0.1], [-0.08, -0.1], [-0.25, -0.88], [0.59, 0.21], [0.09, 0.21]]))
      break
    case 'warehouse':
      line([[0, 0.76], [0.67, 0.4], [0.67, -0.38], [0, -0.76], [-0.67, -0.38], [-0.67, 0.4]], true)
      line([[-0.67, 0.4], [0, 0.03], [0.67, 0.4]])
      line([[0, 0.03], [0, -0.76]])
      break
    case 'unknown':
      line([[-0.42, 0.43], [-0.24, 0.68], [0.22, 0.68], [0.42, 0.45], [0.35, 0.17], [0, -0.06], [0, -0.24]])
      parts.push(new THREE.CircleGeometry(0.1, 12).translate(0, -0.61, 0))
      break
  }

  const result = mergeGeometries(parts, false)
  for (const part of parts) part.dispose()
  if (result === null) throw new Error('节点语义图标几何合并失败')
  return result
}
