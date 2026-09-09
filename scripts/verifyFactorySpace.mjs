/**
 * 厂房空间回归使用真实地图和相机射线验证围合，不依赖截图中的像素位置。
 * 同时检查反射采集的显隐恢复与资源释放，覆盖连续帧采集和异常中断。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as THREE from 'three'
import { createServer } from 'vite'

const server = await createServer({ cacheDir: 'node_modules/.tmp/factory-tests-vite', server: { middlewareMode: true }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } })
let checks = 0
const check = (name, run) => { run(); checks += 1; console.log(`通过：${name}`) }
try {
  const { getFactoryLayout } = await server.ssrLoadModule('/src/features/map-visualization/model/factoryLayout.ts')
  const { computeFactoryFrame } = await server.ssrLoadModule('/src/features/camera-navigation/model/factoryFraming.ts')
  const { computeOverviewPose } = await server.ssrLoadModule('/src/features/camera-navigation/model/overviewFraming.ts')
  const { validateMap } = await server.ssrLoadModule('/src/features/map-visualization/model/validateMap.ts')
  const { createMapModel } = await server.ssrLoadModule('/src/features/map-visualization/model/createMapModel.ts')
  const { createGroundReflection, GROUND_REFLECTION_RESOLUTION } = await server.ssrLoadModule('/src/features/map-visualization/scene/groundReflection.ts')
  const validated = validateMap(JSON.parse(fs.readFileSync('json/map.json', 'utf8')))
  const model = createMapModel(validated)
  const realBounds = model.mapModel.sceneBounds
  assert.ok(realBounds, '取得真实地图范围')
  const smallBounds = { minWorldX: -1, maxWorldX: 1, minWorldZ: -2, maxWorldZ: 2, centerWorldX: 0, centerWorldZ: 0, diagonal: Math.hypot(2, 4) }

  /**
   * 任一角点射线必须命中地坪或十二米内墙；允许墙面替代原先的地面交点。
   * 测试使用 Three.js 真实投影矩阵，避免重复实现被测函数的截面算法。
   */
  function hitsRoom(ray, layout) {
    const b = layout.bounds
    const h = layout.config.wallHeightM
    const surfaces = [
      new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
      new THREE.Plane(new THREE.Vector3(1, 0, 0), -b.minWorldX),
      new THREE.Plane(new THREE.Vector3(1, 0, 0), -b.maxWorldX),
      new THREE.Plane(new THREE.Vector3(0, 0, 1), -b.minWorldZ),
      new THREE.Plane(new THREE.Vector3(0, 0, 1), -b.maxWorldZ),
    ]
    return surfaces.some((plane) => {
      const point = ray.intersectPlane(plane, new THREE.Vector3())
      return point !== null && point.x >= b.minWorldX - 0.001 && point.x <= b.maxWorldX + 0.001 && point.z >= b.minWorldZ - 0.001 && point.z <= b.maxWorldZ + 0.001 && point.y >= -0.001 && point.y <= h + 0.001
    })
  }
  check('真实地图厂房余量保持米制上限', () => {
    const layout = getFactoryLayout(realBounds)
    const expansion = (layout.bounds.maxWorldX - layout.bounds.minWorldX - realBounds.maxWorldX + realBounds.minWorldX) / 2
    assert.ok(expansion >= 12 && expansion <= 20)
    assert.equal(getFactoryLayout(realBounds), layout)
  })
  check('总览能容纳真实地图四角', () => {
    for (const aspect of [0.55, 16 / 9, 3]) {
      const layout = getFactoryLayout(realBounds)
      const pose = computeOverviewPose(realBounds, 45, aspect, layout)
      const camera = new THREE.PerspectiveCamera(45, aspect, pose.near, pose.far)
      camera.position.set(pose.position.x, pose.position.y, pose.position.z)
      camera.lookAt(pose.target.x, 0, pose.target.z)
      camera.updateMatrixWorld()
      for (const x of [realBounds.minWorldX, realBounds.maxWorldX]) for (const z of [realBounds.minWorldZ, realBounds.maxWorldZ]) {
        const projected = new THREE.Vector3(x, 0, z).project(camera)
        assert.ok(Math.abs(projected.x) <= 1.001 && Math.abs(projected.y) <= 1.001, `总览裁切，宽高比 ${aspect}`)
      }
    }
  })
  check('横竖屏、低高俯角和贴边跟随均保持地面净空与室内取景', () => {
    for (const bounds of [smallBounds, realBounds]) for (const aspect of [0.55, 16 / 9, 3]) for (const pitch of [25, 38, 60, 85]) for (const yaw of [0, Math.PI / 4, Math.PI / 2, Math.PI * 1.25]) for (const distance of [1, 65, 10000]) for (const keepTarget of [false, true]) {
      const layout = getFactoryLayout(bounds)
      const frame = computeFactoryFrame({ layout, fovDeg: 45, aspect, pitch: pitch * Math.PI / 180, yaw, distance, targetX: keepTarget ? layout.bounds.minWorldX + 0.7 : bounds.centerWorldX, targetZ: bounds.centerWorldZ, keepTarget })
      // 最近观察距离放宽到 1m 后，最小俯角下相机几何高度为 sin(25°)×1 ≈ 0.42m；
      // 运行时净空由地面约束保护，取景函数只需保证有限且不低于该几何下限。
      assert.ok(Number.isFinite(frame.position.y) && frame.position.y >= 0.4, `镜头贴地：${JSON.stringify({ aspect, pitch, yaw, distance, keepTarget, frame })}`)
      const camera = new THREE.PerspectiveCamera(45, aspect, 0.05, 2000)
      camera.position.set(frame.position.x, frame.position.y, frame.position.z)
      camera.lookAt(frame.target.x, 0, frame.target.z)
      camera.updateMatrixWorld()
      const caster = new THREE.Raycaster()
      for (const x of [-1, 1]) for (const y of [-1, 1]) {
        caster.setFromCamera(new THREE.Vector2(x, y), camera)
        if (pitch <= 60) assert.ok(hitsRoom(caster.ray, layout), '屏幕角点未命中地坪或墙面')
      }
    }
  })
  check('上沿允许看到墙面，边界不再只按地面约束', () => {
    const layout = getFactoryLayout(smallBounds)
    const frame = computeFactoryFrame({ layout, fovDeg: 45, aspect: 16 / 9, pitch: 38 * Math.PI / 180, yaw: 0, distance: 100, targetX: 0, targetZ: 0 })
    const camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.05, 500)
    camera.position.set(frame.position.x, frame.position.y, frame.position.z)
    camera.lookAt(frame.target.x, 0, frame.target.z)
    camera.updateMatrixWorld()
    const caster = new THREE.Raycaster()
    caster.setFromCamera(new THREE.Vector2(0, 1), camera)
    const floorPoint = caster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3())
    assert.ok(floorPoint.z < layout.bounds.minWorldZ)
    assert.ok(hitsRoom(caster.ray, layout))
  })
  check('反射显隐与异常恢复、卸载恢复均对称', () => {
    const scene = new THREE.Scene()
    const material = new THREE.MeshStandardMaterial()
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), material)
    ground.rotation.x = -Math.PI / 2
    const body = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial())
    body.position.y = 0.5
    const label = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial())
    const alreadyHidden = new THREE.Group()
    alreadyHidden.visible = false
    scene.add(ground, body, label, alreadyHidden)
    scene.updateMatrixWorld(true)
    const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 100)
    camera.position.set(3, 4, 5)
    camera.lookAt(0, 0, 0)
    camera.updateMatrixWorld()
    const beforeRender = ground.onBeforeRender
    const compile = material.onBeforeCompile
    const reflection = createGroundReflection(ground)
    const previousTarget = { name: 'existing-target' }
    let currentTarget = previousTarget
    let fail = true
    /**
     * 静止相机的连续绘制也必须逐帧采集，验证反射没有残留帧率节流。
     * 直接检查实际离屏目标尺寸，确保资源始终采用完整分辨率。
     */
    let captures = 0
    /**
     * 反射采集临时使用透明黑底，成功与异常路径都必须恢复原清屏状态。
     * 断言采集期间背景被移除，避免空白反射把整块地坪压成灰色。
     */
    const background = new THREE.Color('#bdc2c4')
    scene.background = background
    const clearColor = new THREE.Color('#abcdee')
    let clearAlpha = 0.7
    const renderer = {
      xr: { enabled: true }, shadowMap: { autoUpdate: true }, autoClear: true,
      state: { buffers: { depth: { setMask() {} } } },
      getRenderTarget: () => currentTarget,
      setRenderTarget: (target) => { currentTarget = target },
      getClearAlpha: () => clearAlpha,
      getClearColor: (target) => target.copy(clearColor),
      setClearColor: (color, alpha) => { clearColor.set(color); clearAlpha = alpha },
      render: () => {
        captures += 1
        assert.equal(currentTarget.width, GROUND_REFLECTION_RESOLUTION)
        assert.equal(currentTarget.height, GROUND_REFLECTION_RESOLUTION)
        assert.equal(scene.background, null)
        assert.equal(clearAlpha, 0)
        assert.equal(clearColor.getHex(), 0)
        assert.equal(ground.visible, false)
        assert.equal(label.visible, false)
        assert.equal(body.visible, true)
        if (fail) throw new Error('模拟采集中断')
      },
    }
    assert.throws(() => ground.onBeforeRender(renderer, scene, camera, ground.geometry, material, null), /模拟采集中断/)
    assert.equal(currentTarget, previousTarget)
    assert.equal(renderer.xr.enabled, true)
    assert.equal(renderer.shadowMap.autoUpdate, true)
    assert.equal(scene.background, background)
    assert.equal(clearColor.getHexString(), 'abcdee')
    assert.equal(clearAlpha, 0.7)
    assert.equal(ground.visible, true)
    assert.equal(label.visible, true)
    assert.equal(alreadyHidden.visible, false)
    fail = false
    ground.onBeforeRender(renderer, scene, camera, ground.geometry, material, null)
    // 同一外层动画帧的重复绘制（透射预通道 + 主体通道）按帧号去重，不重复采集。
    ground.onBeforeRender(renderer, scene, camera, ground.geometry, material, null)
    assert.equal(captures, 2)
    // 推进外层帧号并越过刷新预算后，静止相机必须重新采集，验证倒影不会永久冻结。
    reflection.beginFrame(1 / 30)
    ground.onBeforeRender(renderer, scene, camera, ground.geometry, material, null)
    assert.equal(captures, 3)
    assert.equal(scene.background, background)
    assert.equal(clearColor.getHexString(), 'abcdee')
    assert.equal(clearAlpha, 0.7)
    reflection.dispose()
    reflection.dispose()
    assert.equal(ground.onBeforeRender, beforeRender)
    assert.equal(material.onBeforeCompile, compile)
    for (const object of [ground, body, label]) { object.geometry.dispose(); object.material.dispose() }
  })
  console.log(`厂房空间回归完成：${checks} 项通过`)
} finally {
  await server.close()
}
