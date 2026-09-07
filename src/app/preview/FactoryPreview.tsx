/**
 * 厂房空间样板直接复用正式地坪、墙体和灯光，提供可复现的验收机位。
 * 只在开发入口启用；灰色体块用于观察比例、接触阴影和倒影，不进入真实地图。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { GroundLayer } from '@/features/map-visualization/components/GroundLayer'
import { FactoryLayer } from '@/features/map-visualization/components/FactoryLayer'
import { SceneLighting } from '@/features/map-visualization/components/MapVisualizationFeature'
import { getFactoryLayout } from '@/features/map-visualization/model/factoryLayout'
import { MAP_CLEAR_COLOR } from '@/features/map-visualization/scene/mapAppearance'

const mapBounds = { minWorldX: -16, maxWorldX: 16, minWorldZ: -12, maxWorldZ: 12, centerWorldX: 0, centerWorldZ: 0, diagonal: 40 }
const layout = getFactoryLayout(mapBounds)
const views = {
  空间样板: { position: [24, 18, 27], target: [0, 0, -9] },
  墙脚近景: { position: [16, 3.5, -13], target: [9, 1.6, -24] },
  地坪倒影: { position: [10, 4.5, 4], target: [-2, 1, -10] },
  高位总览: { position: [30, 55, 34], target: [0, 0, 0] },
} satisfies Record<string, { position: [number, number, number]; target: [number, number, number] }>
/**
 * 空间样板与正式地图使用相同的对数深度，保留远墙薄层之间的深度差。
 * 验收时无需抬高近裁剪面，也不会因预览使用不同深度模式而掩盖问题。
 */
const renderer = { antialias: true, toneMapping: THREE.ACESFilmicToneMapping, logarithmicDepthBuffer: true }
const shadows = { type: THREE.PCFShadowMap }
const initialCamera = { fov: 42, near: 0.05, far: 400, position: views.空间样板.position }

export default function FactoryPreview() {
  const [view, setView] = useState<keyof typeof views>('空间样板')
  /**
   * 验收始终使用正式场景的完整倒影精度，移除低档和关闭入口。
   * 保留资源重建入口，检查重建后材质是否正确绑定新的反射纹理。
   */
  const [generation, setGeneration] = useState(0)
  const [metrics, setMetrics] = useState('等待渲染')
  return <main style={{ width: '100vw', height: '100vh', background: MAP_CLEAR_COLOR }}>
    <Canvas camera={initialCamera} gl={renderer} shadows={shadows} dpr={[1, 1.5]}>
      <color attach="background" args={[MAP_CLEAR_COLOR]} />
      <GroundLayer key={`floor-${generation}`} bounds={layout.bounds} />
      <FactoryLayer key={`walls-${generation}`} layout={layout} />
      <SceneLighting bounds={layout.bounds} wallHeight={layout.config.wallHeightM} shadowMapSize={2048} contextGeneration={generation} />
      <ReferenceBlocks />
      <PreviewCamera view={view} />
      <PreviewMetrics onMetrics={setMetrics} />
    </Canvas>
    <output style={{ position: 'absolute', right: 20, top: 20, whiteSpace: 'pre', color: '#405765', fontSize: 12 }}>{metrics}</output>
    {/* 控件只用于验收固定机位与资源释放，保持在画布边缘。
        场景由正式模块渲染，切换机位不会替换任何材质或建筑实现。 */}
    <nav aria-label="厂房空间验收" style={{ position: 'absolute', left: 20, bottom: 20, display: 'flex', gap: 6, padding: 8, borderRadius: 8, background: '#eef1f2e8', boxShadow: '0 3px 20px #29333b20', fontSize: 13 }}>
      {(Object.keys(views) as (keyof typeof views)[]).map((name) => <button key={name} aria-pressed={view === name} onClick={() => setView(name)} style={{ border: 0, borderRadius: 5, padding: '8px 12px', background: view === name ? '#405765' : '#dde3e6', color: view === name ? 'white' : '#273942', cursor: 'pointer' }}>{name}</button>)}
      <button onClick={() => setGeneration((value) => value + 1)}>重建资源</button>
      <a href="./" style={{ padding: 8, color: '#405765' }}>真实地图</a>
    </nav>
  </main>
}

/**
 * 每秒汇总帧率和存活资源，验证反复重建后没有资源累积。
 * 诊断只进入开发样板的低频文本，不把逐帧状态写入正式业务界面。
 */
function PreviewMetrics({ onMetrics }: { onMetrics(value: string): void }) {
  const sample = useRef({ elapsed: 0, frames: 0 })
  useFrame(({ gl }, delta) => {
    sample.current.elapsed += delta
    sample.current.frames += 1
    if (sample.current.elapsed < 1) return
    onMetrics(`${Math.round(sample.current.frames / sample.current.elapsed)} FPS · ${gl.info.memory.geometries} 几何 · ${gl.info.memory.textures} 纹理`)
    sample.current.elapsed = 0
    sample.current.frames = 0
  })
  return null
}

/**
 * 固定机位切换后仍可自由旋转，便于检查墙体剖切与不同角度的地坪反射。
 * 近景样板允许靠近墙脚，正式监控的相机约束另由回归脚本验证。
 */
function PreviewCamera({ view }: { view: keyof typeof views }) {
  const camera = useThree((state) => state.camera)
  useEffect(() => {
    camera.position.set(...views[view].position)
    camera.lookAt(new THREE.Vector3(...views[view].target))
    camera.updateMatrixWorld()
  }, [camera, view])
  return <OrbitControls key={view} target={views[view].target} minDistance={2} maxDistance={110} maxPolarAngle={Math.PI / 2 - 0.05} />
}

/**
 * 少量倒角体块提供稳定的阴影和反射参照，统一灰度避免业务颜色干扰判断。
 * 资源集中创建并对称释放，反复切换验收机位不会增加几何或材质数量。
 */
function ReferenceBlocks() {
  const resources = useMemo(() => ({
    upper: new RoundedBoxGeometry(3.2, 1.9, 2.6, 2, 0.045),
    base: new RoundedBoxGeometry(3.2, 1.1, 2.6, 2, 0.035),
    light: new THREE.MeshStandardMaterial({ color: '#b9bec1', roughness: 0.48 }),
    dark: new THREE.MeshStandardMaterial({ color: '#697278', roughness: 0.62 }),
  }), [])
  useEffect(() => () => {
    for (const resource of Object.values(resources)) resource.dispose()
  }, [resources])
  return <group name="space-reference-blocks" dispose={null}>
    {[-10, -3, 4, 11].flatMap((x) => [-12, -5].map((z) => <group key={`${x}-${z}`} position={[x, 0, z]}>
      <mesh geometry={resources.base} material={resources.dark} position={[0, 0.55, 0]} castShadow receiveShadow />
      <mesh geometry={resources.upper} material={resources.light} position={[0, 2.05, 0]} castShadow receiveShadow />
    </group>))}
  </group>
}
