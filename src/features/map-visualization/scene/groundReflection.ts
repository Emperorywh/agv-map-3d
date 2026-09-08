/**
 * 地坪反射复用 Three.js 的镜像相机和裁剪平面，叠加在标准受光材质上。
 * 反射只采集实体，模糊采样与菲涅耳权重控制涂层质感；所有资源由句柄释放。
 */
import * as THREE from 'three'
import { Reflector } from 'three/addons/objects/Reflector.js'
import { registerReflectionCamera } from '@/shared/rendering/projectedLod'
import { getReflectionMaterial } from '@/shared/rendering/reflectionMaterials'

/**
 * 默认均衡预算保留柔和倒影，高画质档可以显式提高尺寸与刷新频率。
 * 镜头变化立即重新采集，静止镜头下仍定期采集车辆运动和状态灯变化。
 */
export const GROUND_REFLECTION_RESOLUTION = 512

export function createGroundReflection(mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>, resolution = GROUND_REFLECTION_RESOLUTION, fps = 30) {
  const geometry = new THREE.PlaneGeometry(1, 1)
  const reflector = new Reflector(geometry, { textureWidth: resolution, textureHeight: resolution, multisample: 0, clipBias: 0.001 })
  reflector.rotation.x = -Math.PI / 2
  reflector.position.copy(mesh.position)
  reflector.updateMatrixWorld(true)
  const reflectorMaterial = reflector.material as THREE.ShaderMaterial
  const worldProjection = new THREE.Matrix4()
  const inverseReflector = reflector.matrixWorld.clone().invert()
  const projection = { value: worldProjection }
  const texture = { value: reflector.getRenderTarget().texture }
  /**
   * 离屏纹理生成降采样层，模糊采样使用预过滤结果，保持灯带倒影连续。
   * 单次场景采集即可获得柔和倒影，不增加独立的全屏模糊渲染通道。
   */
  texture.value.generateMipmaps = true
  texture.value.minFilter = THREE.LinearMipmapLinearFilter
  /**
   * 模糊层级在完整采集尺寸下固定，近地车辆仍保留可辨认的倒置轮廓。
   * 使用显式层级，避免屏幕导数再次叠加模糊、把小型车辆倒影抹掉。
   */
  const blur = { value: 1.2 }
  const ready = { value: 0 }
  const material = mesh.material
  const originalCompile = material.onBeforeCompile
  const originalKey = material.customProgramCacheKey
  const originalRender = mesh.onBeforeRender

  /**
   * 在光照计算完成后混合线性空间的倒影，再交给既有色调映射输出。
   * 地坪使用世界坐标投影，兼容几何已旋转且网格本身不旋转的现有实现。
   */
  material.onBeforeCompile = (shader, renderer) => {
    originalCompile.call(material, shader, renderer)
    Object.assign(shader.uniforms, { groundReflectionProjection: projection, groundReflectionTexture: texture, groundReflectionReady: ready, groundReflectionBlur: blur })
    shader.vertexShader = `uniform mat4 groundReflectionProjection;
varying vec4 vGroundReflection;
${shader.vertexShader}`.replace('#include <project_vertex>', `#include <project_vertex>
vGroundReflection = groundReflectionProjection * modelMatrix * vec4(transformed, 1.0);`)
    shader.fragmentShader = `uniform sampler2D groundReflectionTexture;
uniform float groundReflectionReady;
uniform float groundReflectionBlur;
varying vec4 vGroundReflection;
${shader.fragmentShader}`.replace('#include <opaque_fragment>', `
// 透明背景随颜色一起预过滤，只让实体倒影覆盖受光地坪。
// 空白区域保留原本的明亮底色，不再混入清屏灰色形成整片灰蒙遮罩。
vec2 reflectionUv = vGroundReflection.xy / max(vGroundReflection.w, 0.0001);
float reflectionBlur = groundReflectionBlur + roughnessFactor * 0.8;
vec4 reflected = textureLod(groundReflectionTexture, reflectionUv, reflectionBlur);
float reflectionEdge = smoothstep(0.0, 0.025, min(min(reflectionUv.x, reflectionUv.y), min(1.0 - reflectionUv.x, 1.0 - reflectionUv.y)));
float grazing = pow(1.0 - max(dot(normalize(normal), normalize(vViewPosition)), 0.0), 3.0);
float reflectionWeight = groundReflectionReady * reflectionEdge * (0.42 + 0.12 * grazing);
outgoingLight = outgoingLight * (1.0 - reflected.a * reflectionWeight) + reflected.rgb * reflectionWeight;
#include <opaque_fragment>`)
  }
  material.customProgramCacheKey = () => `${originalKey.call(material)}-ground-reflection-v2`
  /**
   * 同一材质切换回已用过的程序时，Three.js 不会再次执行编译回调。
   * 清理材质程序缓存以绑定本次反射纹理；地坪几何与三张源纹理继续复用。
   */
  material.dispose()
  material.needsUpdate = true
  const hidden: THREE.Object3D[] = []
  const replacedMeshes: THREE.Mesh[] = []
  const replacedMaterials: (THREE.Material | THREE.Material[])[] = []
  let capturing = false
  let frame = 0
  let capturedFrame = -1
  let capturedCamera: THREE.Camera | null = null
  /**
   * 缓存采集相机和时间，复用颜色草稿；跳帧时保持上次纹理与投影矩阵成对使用。
   * 暂停恢复后的大时间差只触发一次采集，不补跑后台积累的帧。
   */
  let elapsed = 0
  let capturedAt = -Infinity
  const capturedWorld = new THREE.Matrix4()
  const capturedProjection = new THREE.Matrix4()
  const clearColor = new THREE.Color()

  /**
   * 地坪所有者在场景开始绘制前调用本钩子，确保车辆位置、墙体剖切已经更新。
   * 随后的地面绘制复用本帧倒影，透射预通道不再被镜像采集中断。
   * 移动镜头立即刷新，静止镜头按预算采集；车辆运动不会导致倒影永久冻结。
   * 重入保护和外层帧号共同阻止透射与主体通道重复采集。
   */
  mesh.onBeforeRender = (renderer, scene, camera, renderGeometry, renderMaterial, group) => {
    if (capturing) return
    originalRender.call(mesh, renderer, scene, camera, renderGeometry, renderMaterial, group)
    /**
     * 透射预通道与主体通道会在同一帧重复绘制地坪，共用同一相机的倒影即可。
     * 按外层动画帧而非渲染器计数去重，嵌套镜像渲染不会误判为新的一帧。
     */
    if (capturedFrame === frame && capturedCamera === camera) return
    const cameraChanged = capturedCamera !== camera || !capturedWorld.equals(camera.matrixWorld) || !capturedProjection.equals(camera.projectionMatrix)
    if (!cameraChanged && elapsed - capturedAt < 1 / fps - 0.001) return
    capturing = true
    const renderTarget = renderer.getRenderTarget()
    const xrEnabled = renderer.xr.enabled
    const shadowAutoUpdate = renderer.shadowMap.autoUpdate
    const background = scene.background
    const clearAlpha = renderer.getClearAlpha()
    renderer.getClearColor(clearColor)
    try {
      /**
       * 反射纹理只记录实体覆盖率，透明清屏不会把场景背景烘进地面。
       * 黑色透明底保证降采样后的颜色已按覆盖率加权，倒影边缘没有灰色光圈。
       */
      scene.background = null
      renderer.setClearColor(0x000000, 0)
      scene.traverse((object) => {
        /**
         * 必须在镜像渲染器收集绘制列表之前替换水晶材质，才能省去反射透射预通道。
         * 外层主画面的材质在 finally 中完整恢复，异常也不会让简化材质留在近景。
         */
        if (object instanceof THREE.Mesh) {
          const replacement = getReflectionMaterial(object)
          if (replacement !== undefined && replacement !== object.material) {
            replacedMeshes.push(object)
            replacedMaterials.push(object.material)
            object.material = replacement
          }
        }
        const unlit = object instanceof THREE.Mesh && !Array.isArray(object.material) && object.material instanceof THREE.MeshBasicMaterial
        /**
         * 允许监控贴花通过中立标记整组退出反射采集，兼容虚线等自定义材质。
         * 标记只影响镜像相机，主画面可见性仍在采集完成后原样恢复。
         */
        if (object.visible && (object === mesh || unlit || object.name === 'fleet-labels' || object.userData['excludeFromGroundReflection'] === true)) {
          hidden.push(object)
          object.visible = false
        }
      })
      /**
       * 当前 Three.js 为每个源相机维护镜像相机，采集前登记对应的几何预算。
       * 注册仅保存弱引用，不依赖反射器内部字段，也不延长相机生命周期。
       */
      registerReflectionCamera(reflector.getReflectionCamera(camera))
      reflector.onBeforeRender(renderer, scene, camera, geometry, reflectorMaterial, group)
      worldProjection.copy(reflectorMaterial.uniforms.textureMatrix.value).multiply(inverseReflector)
      ready.value = 1
      capturedFrame = frame
      capturedCamera = camera
      capturedAt = elapsed
      capturedWorld.copy(camera.matrixWorld)
      capturedProjection.copy(camera.projectionMatrix)
    } finally {
      scene.background = background
      renderer.setClearColor(clearColor, clearAlpha)
      for (const object of hidden) object.visible = true
      hidden.length = 0
      for (let index = 0; index < replacedMeshes.length; index += 1) replacedMeshes[index].material = replacedMaterials[index]
      replacedMeshes.length = replacedMaterials.length = 0
      renderer.xr.enabled = xrEnabled
      renderer.shadowMap.autoUpdate = shadowAutoUpdate
      renderer.setRenderTarget(renderTarget)
      capturing = false
    }
  }
  let disposed = false
  return {
    /**
     * 累积外层动画时间，同时推进同帧去重编号。
     * 分辨率与刷新预算固定到资源代，避免不断重建反射纹理。
     */
    beginFrame(delta = 1 / 60) { frame += 1; elapsed += delta },
    dispose() {
      if (disposed) return
      disposed = true
      mesh.onBeforeRender = originalRender
      material.onBeforeCompile = originalCompile
      material.customProgramCacheKey = originalKey
      /**
       * 卸载时清理旧程序，防止资源重建后仍读取已经释放的倒影纹理。
       * 先恢复材质回调，再由地坪所有者释放材质，保证清理路径对称。
       */
      material.dispose()
      material.needsUpdate = true
      reflector.dispose()
      geometry.dispose()
    },
  }
}
