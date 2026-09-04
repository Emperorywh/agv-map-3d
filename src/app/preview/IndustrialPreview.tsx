/**
 * 独立样板入口复用现场的地坪工厂、渐变环境与灯光数值，并提供三个固定机位。
 * 设施坐标全部集中配置，仅开发预览使用，不把缺少布局依据的货架放进真实地图。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import * as THREE from 'three'
import { FleetMonitoringFeature, FleetRuntimeProvider, createFollowTargetReader, type ReadonlyFleetRuntime, type FollowTargetReader } from '@/features/fleet-monitoring'
import { CameraNavigationFeature, type CameraNavigationCommands } from '@/features/camera-navigation'
import { useFleetMonitoringStore } from '@/features/fleet-monitoring/model/fleetMonitoringStore'
import { GroundLayer } from '@/features/map-visualization/components/GroundLayer'
import { createGradientEnvironment } from '@/features/map-visualization/scene/createSceneEnvironment'
import { MAP_CLEAR_COLOR, DIRECTIONAL_LIGHT_INTENSITY } from '@/features/map-visualization/scene/mapAppearance'
import { createChargingCabinet, createIndustrialRack, instanceFacility } from '@/shared/industrial/facilities'
import { createCartonGeometry, createPalletGeometry } from '@/shared/industrial/geometry'
import { createIndustrialMaterials } from '@/shared/industrial/materials'
import type { WorldTransform } from '@/shared/spatial'
import { createPreviewSource, type PreviewSettings } from './previewSource'
import './industrialPreview.css'
import { SAMPLE_LAYOUT } from './sampleLayout'
const transform: WorldTransform = { origin: { x: 0, y: 0 }, toWorldXZ: (x, y) => ({ x, z: -y }), angleToWorldYRotation: (theta) => theta }
const bounds = { minWorldX: -32, maxWorldX: 32, minWorldZ: -32, maxWorldZ: 32, centerWorldX: 0, centerWorldZ: 0, diagonal: Math.hypot(64, 64) }
const views = {
  近景: { position: [2.5, 1.45, 3.1], target: [0, 0.24, 1] },
  中景: { position: [6, 4.3, 7.5], target: [0, 0.65, -0.6] },
  远景: { position: [15, 11, 17], target: [0, 0.3, 0] },
  车队: { position: [26, 24, 31], target: [0, 0, 0] },
} satisfies Record<string, { position: [number, number, number]; target: [number, number, number] }>
/**
 * 渲染器和初始相机配置保持引用稳定，统计面板刷新不会再次覆盖固定机位。
 * 预览使用当前阴影类型，避免重复应用旧类型导致每秒产生弃用提示。
 */
const previewCamera = { fov: 45, near: 0.05, far: 500, position: views.中景.position }
const previewRenderer = { antialias: true, toneMapping: THREE.ACESFilmicToneMapping }
const previewShadows = { type: THREE.PCFShadowMap }

export default function IndustrialPreview() {
  const source = useMemo(createPreviewSource, [])
  const [settings, setSettings] = useState<PreviewSettings>({ count: 1, theta: 0, loaded: false, state: 'EXECUTING', procedural: false, moving: false })
  const [view, setView] = useState<keyof typeof views>('中景')
  const [metrics, setMetrics] = useState('等待渲染')
  const [following, setFollowing] = useState<string | null>(null)
  const [generation, setGeneration] = useState(0)
  /**
   * 样板也使用正式相机导航和跟随适配器，双击验证覆盖实际跟随状态机。
   * 仅数据源隔离，车辆拾取、中心偏移和相机事件处理与真实场景共用代码。
   */
  const commands = useRef<CameraNavigationCommands | null>(null)
  const [runtime, setRuntime] = useState<ReadonlyFleetRuntime | null>(null)
  const followReader = useMemo(() => runtime === null ? null : createFollowTargetReader({ runtime, worldTransform: transform }), [runtime])
  const selected = useFleetMonitoringStore((state) => state.selectedKey)
  const hovered = useFleetMonitoringStore((state) => state.hoveredKey)
  useEffect(() => { source.configure(settings) }, [source, settings])
  return <main className="industrial-preview">
    {/* 预览面板独占左侧空间，窄窗口下也不覆盖需要检查的车辆主体。
        相机保持固定世界机位，画布按剩余宽度更新投影比例。 */}
    <Canvas style={{ marginLeft: 330, width: 'calc(100% - 330px)', height: '100%' }} shadows={previewShadows} camera={previewCamera} gl={previewRenderer}>
      <color attach="background" args={[MAP_CLEAR_COLOR]} />
      <PreviewStage view={view} count={settings.count} onMetrics={setMetrics} generation={generation} commands={commands} followReader={followReader} onFollowedChange={setFollowing} />
      <FleetRuntimeProvider source={source} onRuntimeAvailable={setRuntime}>
        <FleetMonitoringFeature worldTransform={transform} contextGeneration={generation} onFollowRequest={(key) => commands.current?.follow(key)} />
      </FleetRuntimeProvider>
    </Canvas>
    <aside className="industrial-preview-panel">
      <div className="industrial-eyebrow">INDUSTRIAL ASSETS / 01</div>
      <h1>工业设备样板</h1>
      <p>同地坪 · 同材质环境 · 米制尺寸</p>
      <div className="industrial-controls">{(['近景', '中景', '远景'] as const).map((name) => <button key={name} aria-pressed={view === name} onClick={() => setView(name)}>{name}</button>)}</div>
      <label>运行状态<select value={settings.state} onChange={(event) => setSettings({ ...settings, state: event.target.value as PreviewSettings['state'] })}>
        <option value="EXECUTING">普通运行</option><option value="CHARGING">充电</option><option value="FAULT">故障</option><option value="OFFLINE">离线</option><option value="STALE">数据过期（等待 10 秒）</option>
      </select></label>
      <label><input type="checkbox" checked={settings.loaded} onChange={(event) => setSettings({ ...settings, loaded: event.target.checked })} />车辆载货</label>
      <label><input type="checkbox" checked={settings.procedural} onChange={(event) => setSettings({ ...settings, procedural: event.target.checked })} />异尺寸程序回退</label>
      <label><input type="checkbox" checked={settings.moving} onChange={(event) => setSettings({ ...settings, moving: event.target.checked })} />连续转向</label>
      <div className="industrial-controls"><button onClick={() => setSettings({ ...settings, theta: settings.theta + Math.PI / 2 })}>转向 90°</button><button onClick={() => {
        const count = settings.count === 1 ? 200 : 1
        setSettings({ ...settings, count }); setView(count === 1 ? '中景' : '车队')
      }}>{settings.count === 1 ? '200 辆车' : '返回样板'}</button></div>
      <button onClick={() => setGeneration((value) => value + 1)}>重建模型资源</button>
      <output>选中：{selected ?? '无'}<br />悬停：{hovered ?? '无'}<br />正在跟随：{following ?? '无'}</output>
      <output>{metrics}</output>
      <p className="industrial-note">悬停查看摘要，点击展开信息，Esc 取消。双击跟随车辆，拖拽地图退出跟随。</p>
      <a href="./">返回真实地图</a>
    </aside>
  </main>
}

/**
 * 固定机位之外允许轨道观察；样板与车队共用实际批次渲染和选择处理器。
 * 统计来自渲染器的真实帧数据，便于直接对比资源复用和绘制开销。
 */
function PreviewStage({ view, count, onMetrics, generation, commands, followReader, onFollowedChange }: {
  view: keyof typeof views; count: number; onMetrics(value: string): void; generation: number
  commands: { current: CameraNavigationCommands | null }; followReader: FollowTargetReader | null; onFollowedChange(key: string | null): void
}) {
  const { camera, gl, scene } = useThree()
  const controls = useRef<OrbitControls | null>(null)
  const stats = useRef({ time: 0, frames: 0 })
  useEffect(() => {
    commands.current?.exitFollow()
    /**
     * 独立样板允许近距离检查倒角，仅调整此预览拥有的轨道实例。
     * 正式地图相机的厂房边界与最小距离配置保持原有逻辑。
     */
    if (controls.current !== null) controls.current.minDistance = 0.8
    camera.position.set(...views[view].position)
    controls.current?.target.set(...views[view].target)
    controls.current?.update()
  }, [camera, view, commands])
  useEffect(() => {
    const environment = createGradientEnvironment(gl)
    scene.environment = environment.texture
    return () => { scene.environment = null; environment.dispose() }
  }, [gl, scene, generation])
  useFrame((_, delta) => {
    stats.current.time += delta; stats.current.frames += 1
    if (stats.current.time < 1) return
    const model = scene.getObjectByName('fleet-glbPaint-b0')
    onFollowedChange(commands.current?.getFollowedKey() ?? null)
    onMetrics(`${count} 辆 · ${model?.visible ? '精修 GLB' : '程序模型'} · ${Math.round(stats.current.frames / stats.current.time)} FPS\n${gl.info.render.calls} 次绘制 · ${gl.info.render.triangles.toLocaleString()} 三角形\n${gl.info.memory.geometries} 几何 · ${gl.info.memory.textures} 纹理\n相机 ${camera.position.toArray().map((v) => v.toFixed(1)).join(' / ')}`)
    stats.current = { time: 0, frames: 0 }
  })
  return <>
    <CameraNavigationFeature bounds={null} controlsRef={controls} commandsRef={commands} readFollowTarget={followReader} />
    <directionalLight position={[6, 45, 4]} intensity={DIRECTIONAL_LIGHT_INTENSITY} castShadow shadow-mapSize={[2048, 2048]} shadow-camera-left={-28} shadow-camera-right={28} shadow-camera-top={28} shadow-camera-bottom={-28} shadow-camera-far={100} shadow-bias={-0.00008} shadow-normalBias={0.025} />
    <hemisphereLight args={[0xdce5eb, 0x737e87, 1.15]} />
    <GroundLayer bounds={bounds} />
    {count === 1 ? <SampleFacilities key={generation} /> : null}
  </>
}

function SampleFacilities() {
  const resources = useMemo(() => {
    const cabinet = createChargingCabinet()
    const rack = createIndustrialRack(SAMPLE_LAYOUT.rack.dimensions)
    const matrix = (pose: { x: number; y: number; z: number; rotation: number }) => new Float32Array(new THREE.Matrix4().makeRotationY(pose.rotation).setPosition(pose.x, pose.y, pose.z).elements)
    const instances = [instanceFacility(cabinet, matrix(SAMPLE_LAYOUT.cabinet)), instanceFacility(rack, matrix(SAMPLE_LAYOUT.rack))]
    const materials = createIndustrialMaterials()
    const geometries = [createPalletGeometry(), createCartonGeometry(), createCartonGeometry(true)]
    const group = new THREE.Group()
    for (const instance of instances) group.add(instance.group)
    const p = SAMPLE_LAYOUT.pallet
    for (let i = 0; i < 3; i += 1) {
      const mesh = new THREE.Mesh(geometries[i], [materials.wood, materials.cardboard, materials.tape][i])
      mesh.position.set(p.x, i === 0 ? p.height / 2 : p.height + 0.18, p.z)
      mesh.scale.set(p.length * (i === 0 ? 1 : 0.97), i === 0 ? p.height : 0.36, p.width * (i === 0 ? 1 : 0.97))
      mesh.castShadow = true; mesh.receiveShadow = true; group.add(mesh)
    }
    return { group, dispose() {
      for (const instance of instances) instance.dispose()
      cabinet.dispose(); rack.dispose()
      for (const geometry of geometries) geometry.dispose()
      for (const material of Object.values(materials)) material.dispose()
    } }
  }, [])
  useEffect(() => () => resources.dispose(), [resources])
  return <primitive object={resources.group} dispose={null} />
}
