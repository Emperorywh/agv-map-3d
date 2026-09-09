/**
 * 四元素验收入口复用正式相机控制、地坪反射、场景灯光与唯一 Bloom 管线。
 * 小样显式使用可替换演示数据；完整场景读取运行配置的真实地图，不修改拓扑。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { CameraNavigationFeature, type CameraNavigationCommands } from '@/features/camera-navigation'
import { GroundLayer } from '@/features/map-visualization/components/GroundLayer'
import { FactoryLayer } from '@/features/map-visualization/components/FactoryLayer'
import { PhysicalPathsLayer } from '@/features/map-visualization/components/PhysicalPathsLayer'
import { NavigationNodesLayer } from '@/features/map-visualization/components/NavigationNodesLayer'
import { SceneLighting } from '@/features/map-visualization/components/MapVisualizationFeature'
import { SceneBloom } from '@/features/map-visualization/components/SceneBloom'
import { buildMapFromJson } from '@/features/map-visualization/services/loadMap'
import { buildMapGeometry, type MapGeometry } from '@/features/map-visualization/scene/buildMapGeometry'
import { getFactoryLayout } from '@/features/map-visualization/model/factoryLayout'
import { MAP_CLEAR_COLOR } from '@/features/map-visualization/scene/mapAppearance'
import { useNavigationState, type NavigationStatus } from '@/features/map-visualization/model/navigationState'
import { loadStartupConfig, loadStartupMap } from '../bootstrap/bootstrapApplication'
import { createDiagnosticsReporter } from '@/shared/diagnostics'
import { RENDER_QUALITY, RenderQualityContext } from '@/shared/rendering/renderQuality'

/**
 * 演示曲线只服务于先行材质小样，保留标准地图字段，便于替换为其他样板。
 * 正式入口不会在加载失败时静默回退为演示拓扑。
 */
const sample = {
  nodes: [{ id: 'sample-a', name: 'A · 起点', type: 'node', mapId: 'material-sample', x: -4, y: -2 }, { id: 'sample-b', name: 'B · 终点', type: 'node', mapId: 'material-sample', x: 4, y: 2 }],
  edges: [{ id: 'sample-curve', mapId: 'material-sample', edgeType: 'BEZIER', snodeId: 'sample-a', enodeId: 'sample-b', sx: -4, sy: -2, ex: 4, ey: 2, cx: -1, cy: -2, dx: -2, dy: 2, isBackEdge: false }],
}
type Data = ReturnType<typeof buildMapFromJson>
/**
 * 在真实曲线中选取靠近建筑右后角的一条作为验收焦点，便于同时观察墙与路网。
 * 仅改变观察目标和状态示例对象，全部节点、边及坐标原样保留。
 */
function referenceEdge(data: Data) {
  const { mapModel, worldTransform } = data
  const curves = mapModel.edgeList.filter((edge) => edge.edgeType === 'BEZIER')
  return curves.reduce((best, edge) => {
    const score = (value: typeof edge) => {
      const p = worldTransform.toWorldXZ(value.sx, value.sy)
      return Math.hypot(p.x - mapModel.sceneBounds.maxWorldX, p.z - mapModel.sceneBounds.minWorldZ)
    }
    return score(edge) < score(best) ? edge : best
  }, curves[0] ?? mapModel.edgeList[0])
}
const controlStyle = { color: '#bed7e7', background: '#243542', border: '1px solid #466070', borderRadius: 3, padding: '5px 9px', cursor: 'pointer' }
const renderer = { antialias: false, toneMapping: THREE.ACESFilmicToneMapping, logarithmicDepthBuffer: true }
const initialCamera = { fov: 42, near: 0.05, far: 2000, position: [12, 12, 14] as [number, number, number] }

export default function NavigationPreview() {
  const small = new URLSearchParams(window.location.search).get('scene') === 'sample'
  const [data, setData] = useState<Data | null>(() => small ? buildMapFromJson(sample) : null)
  const [error, setError] = useState('')
  const [view, setView] = useState('参考视角')
  const [status, setStatus] = useState<NavigationStatus>('clear')
  const [generation, setGeneration] = useState(0)
  useEffect(() => {
    if (small) return
    const controller = new AbortController()
    const diagnostics = createDiagnosticsReporter()
    void loadStartupConfig({ signal: controller.signal, diagnostics }).then(({ config }) => loadStartupMap(config, { signal: controller.signal, diagnostics })).then((result) => {
      if (!controller.signal.aborted) setData({ mapModel: result.mapModel, worldTransform: result.worldTransform, anomalies: [] })
    }).catch((reason: unknown) => { if (!controller.signal.aborted) setError(String(reason)) })
    return () => controller.abort()
  }, [small])
  useEffect(() => () => useNavigationState.getState().reset(), [])
  const changeStatus = (next: NavigationStatus) => {
    if (!data) return
    /**
     * 验收按钮只改变一条曲线及其重合反向边的展示状态，不发送调度命令。
     * 正式接入同一个 store 即可按业务逻辑边 ID 进行增量更新。
     */
    const curve = referenceEdge(data)
    const patch = Object.fromEntries(data.mapModel.edgeList.filter((edge) => edge.id === curve?.id || (edge.snodeId === curve?.enodeId && edge.enodeId === curve?.snodeId)).map((edge) => [edge.id, next]))
    useNavigationState.getState().setPathStates(patch)
    setStatus(next)
  }
  return <main style={{ width: '100vw', height: '100dvh', background: MAP_CLEAR_COLOR }}>
    <Canvas gl={renderer} camera={initialCamera} shadows={{ type: THREE.PCFShadowMap }} dpr={[1, RENDER_QUALITY.balanced.maxDpr]}>
      <RenderQualityContext.Provider value={RENDER_QUALITY.balanced}>
        <color attach="background" args={[MAP_CLEAR_COLOR]} />
        {data ? <NavigationContents key={generation} data={data} small={small} view={view} /> : null}
      </RenderQualityContext.Provider>
    </Canvas>
    {!data ? <p style={{ position: 'absolute', inset: '45% 10%', textAlign: 'center', color: '#c7dbe6' }}>{error || '正在加载真实地图…'}</p> : null}
    <nav aria-label="导航材质验收" style={{ position: 'absolute', bottom: 16, left: 16, display: 'flex', flexWrap: 'wrap', gap: 6, padding: 8, background: '#141e28e8', maxWidth: 'calc(100vw - 32px)', border: '1px solid #52647466', borderRadius: 6, color: '#bed2df', fontSize: 12 }}>
      <a href={small ? '?scene=navigation' : '?scene=sample'} style={{ color: '#95d9ff', padding: 7 }}>{small ? '真实完整地图' : '两节点材质小样'}</a>
      {['参考视角', '材质近景', '全图'].map((name) => <button style={controlStyle} key={name} aria-pressed={view === name} onClick={() => setView(name)}>{name}</button>)}
      <select style={controlStyle} aria-label="示例曲线状态" value={status} onChange={(event) => changeStatus(event.target.value as NavigationStatus)}>
        <option value="clear">正常通行</option><option value="reserved">预留</option><option value="waiting">等待</option><option value="blocked">局部受阻</option>
      </select>
      <button style={controlStyle} onClick={() => setGeneration((value) => value + 1)}>重建资源</button>
      <span style={{ padding: 7 }}>拖动旋转 · 滚轮缩放 · 点击节点 · Esc 取消</span>
    </nav>
  </main>
}

function NavigationContents({ data, small, view }: { data: Data; small: boolean; view: string }) {
  const { mapModel, worldTransform } = data
  const [geometry, setGeometry] = useState<MapGeometry | null>(null)
  const controls = useRef<OrbitControls | null>(null)
  const commands = useRef<CameraNavigationCommands | null>(null)
  const camera = useThree((state) => state.camera)
  const bounds = mapModel.sceneBounds
  const layout = useMemo(() => {
    const full = getFactoryLayout(bounds)
    if (!small) return full
    const floor = { minWorldX: -9, maxWorldX: 9, minWorldZ: -7, maxWorldZ: 7, centerWorldX: 0, centerWorldZ: 0, diagonal: Math.hypot(18, 14) }
    return { ...full, bounds: floor, walls: [{ name: 'sample', x: 0, z: -6, length: 18, rotation: Math.PI, normalX: 0, normalZ: -1 }] }
  }, [bounds, small])
  useEffect(() => {
    const next = buildMapGeometry(mapModel, worldTransform)
    setGeometry(next)
    return () => next.dispose()
  }, [mapModel, worldTransform])
  useEffect(() => {
    if (!controls.current) return
    /**
     * 全图直接调用正式相机命令，让视场与距离约束共同求解。
     * 不能沿近景距离上限硬设机位，否则控制器会把全图重新裁回局部。
     */
    if (view === '全图') { commands.current?.overview(); return }
    /**
     * 固定验收机位直接设置已有控制器，随后仍由正式相机约束与输入流程接管。
     * 完整地图聚焦真实曲线附近，切到全图可检查所有节点和拓扑。
     */
    const edge = referenceEdge(data)
    const p = small || !edge ? { x: 0, z: 0 } : worldTransform.toWorldXZ((edge.sx + edge.ex) / 2, (edge.sy + edge.ey) / 2)
    const distance = view === '材质近景' ? 7 : small ? 13 : 16
    const whole = view === '全图'
    const x = whole ? bounds.centerWorldX : p.x
    const z = whole ? bounds.centerWorldZ : p.z
    const span = whole ? bounds.diagonal * 0.53 : distance
    controls.current.target.set(x, 0, z)
    camera.position.set(x + span * (small || whole ? 0.65 : -0.85), span * 0.85, z + span)
    controls.current.update()
  }, [camera, data, mapModel, worldTransform, bounds, small, view, geometry])
  return <>
    <CameraNavigationFeature bounds={bounds} readFollowTarget={null} controlsRef={controls} commandsRef={commands} />
    <GroundLayer bounds={layout.bounds} />
    <FactoryLayer layout={layout} />
    {geometry ? <PhysicalPathsLayer geometry={geometry} mapModel={mapModel} worldTransform={worldTransform} /> : null}
    <NavigationNodesLayer mapModel={mapModel} worldTransform={worldTransform} />
    <SceneLighting bounds={layout.bounds} wallHeight={layout.config.wallHeightM} shadowMapSize={2048} contextGeneration={0} />
    <SceneBloom generation={0} />
  </>
}
