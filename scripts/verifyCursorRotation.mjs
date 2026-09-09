/**
 * 使用真实透视相机与控制器验证鼠标落点的屏幕投影，不重复实现旋转补偿算法。
 * 覆盖缩放后的连续旋转、厂房触边、反向拖动，以及既有平移和缩放的落点约束。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { createServer } from 'vite'

const server = await createServer({ cacheDir: 'node_modules/.tmp/cursor-tests-vite', server: { middlewareMode: true }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } })
try {
  const { createGroundNavigation } = await server.ssrLoadModule('/src/features/camera-navigation/scene/createGroundNavigation.ts')
  const { constrainCameraToGround } = await server.ssrLoadModule('/src/features/camera-navigation/scene/constrainCameraToGround.ts')
  const { constrainCameraToFactory } = await server.ssrLoadModule('/src/features/camera-navigation/scene/constrainCameraToFactory.ts')
  const { getFactoryLayout } = await server.ssrLoadModule('/src/features/map-visualization/model/factoryLayout.ts')
  const { validateMap } = await server.ssrLoadModule('/src/features/map-visualization/model/validateMap.ts')
  const { createMapModel } = await server.ssrLoadModule('/src/features/map-visualization/model/createMapModel.ts')
  const bounds = createMapModel(validateMap(JSON.parse(fs.readFileSync('json/map.json', 'utf8')))).mapModel.sceneBounds
  const layout = getFactoryLayout(bounds)
  let checks = 0
  let largestDriftPx = 0

  /**
   * 画布包含页面偏移，横竖屏分别使用真实宽高比，防止坐标换算只在全屏成立。
   * change 与空闲帧都应用正式约束，使测试包含控制器更新之后的最终姿态。
   */
  function setup(aspect, pitch, distance, room = layout, edge = false) {
    const rect = { left: 37, top: 23, width: 800 * aspect, height: 800 }
    const element = { clientHeight: rect.height, getBoundingClientRect: () => rect }
    const camera = new THREE.PerspectiveCamera(45, aspect, 0.05, 5000)
    const controls = new OrbitControls(camera, null)
    controls.enableDamping = false
    controls.target.set(edge ? room.bounds.minWorldX + 1 : bounds.centerWorldX, 0, bounds.centerWorldZ)
    camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(new THREE.Spherical(distance, Math.PI / 2 - pitch * Math.PI / 180, 0.4)))
    const constrain = () => {
      constrainCameraToGround(camera, controls)
      constrainCameraToFactory(camera, controls, room, false)
    }
    constrain()
    controls.addEventListener('change', constrain)
    controls.update()
    return { rect, camera, controls, constrain, navigation: createGroundNavigation(camera, element) }
  }

  function groundAt(state, x, y) {
    const { camera, rect } = state
    camera.updateMatrixWorld()
    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera(new THREE.Vector2((x - rect.left) / rect.width * 2 - 1, 1 - (y - rect.top) / rect.height * 2), camera)
    const point = raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3())
    assert.ok(point, '鼠标射线应命中地面')
    return point
  }

  function assertPinned(state, point, x, y) {
    const { camera, rect } = state
    camera.updateMatrixWorld()
    const projected = point.clone().project(camera)
    const drift = Math.hypot((projected.x + 1) / 2 * rect.width + rect.left - x, (1 - projected.y) / 2 * rect.height + rect.top - y)
    largestDriftPx = Math.max(largestDriftPx, drift)
    assert.ok(drift < 0.01, `鼠标落点漂移 ${drift} 像素`)
    assert.ok(camera.position.y > 0 && state.controls.target.y === 0, '相机与观察中心应满足地面保护')
    checks += 1
  }

  /**
   * 先执行与滚轮相同的缩放，再从偏离屏幕中心的落点连续改变水平与垂直角度。
   * 每步同时验证控制器更新和空闲帧，避免只在事件内固定落点、下一帧又恢复漂移。
   */
  for (const aspect of [0.55, 16 / 9, 3]) for (const pitch of [30, 55, 80]) for (const distance of [1, 10, 65, 400]) for (const cursor of [[0.2, 0.65], [0.75, 0.3]]) {
    const state = setup(aspect, pitch, distance)
    const { rect, controls, camera, navigation, constrain } = state
    const x = rect.left + rect.width * cursor[0]
    const y = rect.top + rect.height * cursor[1]
    for (const factor of [0.45, 2.2]) {
      navigation.zoom(controls.target, x, y, factor, false)
      controls.update()
      const anchor = groundAt(state, x, y)
      for (const [dx, dy] of [[8, 0], [0, 6], [8, -4], [-12, 5]]) {
        navigation.rotate(controls, x, y, dx, dy, constrain)
        controls.update()
        assertPinned(state, anchor, x, y)
        controls.update()
        constrain()
        assertPinned(state, anchor, x, y)
      }
      assert.ok(Number.isFinite(camera.position.length()), '连续交互后机位应有限')
    }
  }

  /**
   * 在足够宽敞的区域验证旋转确实改变方位且不偷偷缩放，正反输入可以返回起点。
   * 用原生旋转建立漂移对照，确保断言能检出本次反馈而非仅验证相机没有运动。
   */
  {
    const state = setup(16 / 9, 55, 10)
    const { rect, camera, controls, navigation, constrain } = state
    const x = rect.left + rect.width * 0.2
    const y = rect.top + rect.height * 0.7
    const anchor = groundAt(state, x, y)
    const before = camera.position.clone()
    const target = controls.target.clone()
    const rotation = camera.quaternion.clone()
    const distance = camera.position.distanceTo(controls.target)
    navigation.rotate(controls, x, y, 40, 12, constrain)
    controls.update()
    assert.ok(camera.quaternion.angleTo(rotation) > 0.1, '拖动应实际改变观察角度')
    assert.ok(Math.abs(camera.position.distanceTo(controls.target) - distance) < 1e-6, '旋转不应改变观察距离')
    assertPinned(state, anchor, x, y)
    navigation.rotate(controls, x, y, -40, -12, constrain)
    controls.update()
    assert.ok(camera.position.distanceTo(before) < 1e-6 && controls.target.distanceTo(target) < 1e-6, '反向旋转应返回原机位')
    controls.rotateLeft(2 * Math.PI * 40 / rect.height)
    const oldProjected = anchor.clone().project(camera)
    assert.ok(Math.hypot((oldProjected.x + 1) / 2 * rect.width + rect.left - x, (1 - oldProjected.y) / 2 * rect.height + rect.top - y) > 5, '原生屏幕中心旋转应能复现漂移')
  }

  /**
   * 贴边连续拖动必须停在可行角度，不能通过厂房约束推走鼠标落点。
   * 停止后反向输入立即恢复旋转，单击与零位移也不能改变机位。
   */
  {
    const state = setup(16 / 9, 38, 65, layout, true)
    const { rect, camera, controls, navigation, constrain } = state
    const x = rect.left + rect.width * 0.2
    const y = rect.top + rect.height * 0.65
    const anchor = groundAt(state, x, y)
    let blocked = false
    for (let step = 0; step < 80; step += 1) {
      const before = camera.position.clone()
      navigation.rotate(controls, x, y, 10, 0, constrain)
      controls.update()
      assertPinned(state, anchor, x, y)
      if (camera.position.distanceTo(before) < 1e-6) { blocked = true; break }
    }
    assert.ok(blocked, '应到达厂房旋转边界')
    const before = camera.position.clone()
    navigation.rotate(controls, x, y, 0, 0, constrain)
    controls.update()
    assert.ok(camera.position.distanceTo(before) < 1e-6, '无位移输入不能移动相机')
    navigation.rotate(controls, x, y, -10, 0, constrain)
    controls.update()
    assert.ok(camera.position.distanceTo(before) > 0.01, '触边后反向拖动应立即生效')
    assertPinned(state, anchor, x, y)
  }

  /**
   * 旋转后的地面平移与定点缩放继续共用同一落点语义。
   * 画布不可见时拒绝求交，不写入非法相机位置。
   */
  {
    const state = setup(16 / 9, 55, 10)
    const { rect, camera, controls, navigation, constrain } = state
    const x = rect.left + rect.width * 0.3
    const y = rect.top + rect.height * 0.6
    navigation.rotate(controls, x, y, 20, 10, constrain)
    controls.update()
    const anchor = groundAt(state, x, y)
    navigation.pan(controls.target, x, y, x + 30, y - 20)
    controls.update()
    assertPinned(state, anchor, x + 30, y - 20)
    navigation.zoom(controls.target, x + 30, y - 20, 0.5, false)
    controls.update()
    assertPinned(state, anchor, x + 30, y - 20)
    const before = camera.position.clone()
    rect.width = 0
    navigation.rotate(controls, x, y, 20, 10, constrain)
    assert.ok(camera.position.equals(before), '不可见画布不能改变相机')
  }
  console.log(`通过：${checks} 次鼠标落点检查；最大屏幕漂移 ${largestDriftPx.toFixed(6)} 像素`)
} finally {
  await server.close()
}
