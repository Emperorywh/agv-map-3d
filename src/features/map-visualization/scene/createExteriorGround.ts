/**
 * 沙盘外侧使用墨蓝无限网格，沿用地坪微纹并叠加细蓝格线和稀疏青色光点。
 * 屏幕四边形通过相机射线求地面交点，旋转、缩放时保持真实透视且没有有限地面边缘。
 */
import * as THREE from 'three'
import type { SceneBounds } from '../model/types'
import {
  EXTERIOR_GROUND_COLOR,
  EXTERIOR_GROUND_GRID_COLOR,
  EXTERIOR_GROUND_POINT_COLOR,
  EXTERIOR_GROUND_GRID_OPACITY,
  EXTERIOR_GROUND_Y,
  GROUND_SEAM_SPACING_M,
  GROUND_SEAM_WIDTH_M,
  GROUND_TEXTURE_TILE_M,
} from './mapAppearance'

/**
 * 外侧仅作为实体后方的地面背景绘制，共享地坪纹理，不另行生成纹理或采集倒影。
 * 调用方先移除并释放本句柄，再释放拥有共享纹理的内部地坪。
 */
export function createExteriorGround(surfaceMap: THREE.Texture | null, bounds: SceneBounds) {
  const geometry = new THREE.PlaneGeometry(2, 2)
  const material = new THREE.ShaderMaterial({
    uniforms: {
      inverseProjection: { value: new THREE.Matrix4() },
      cameraWorld: { value: new THREE.Matrix4() },
      groundColor: { value: new THREE.Color(EXTERIOR_GROUND_COLOR) },
      gridColor: { value: new THREE.Color(EXTERIOR_GROUND_GRID_COLOR) },
      pointColor: { value: new THREE.Color(EXTERIOR_GROUND_POINT_COLOR) },
      groundHeight: { value: EXTERIOR_GROUND_Y },
      groundBoundary: { value: new THREE.Vector4(bounds.minWorldX, bounds.maxWorldX, bounds.minWorldZ, bounds.maxWorldZ) },
      fadeDistance: { value: Math.max(bounds.diagonal * 1.8, 180) },
      panelSize: { value: GROUND_SEAM_SPACING_M },
      seamWidth: { value: GROUND_SEAM_WIDTH_M },
      gridOpacity: { value: EXTERIOR_GROUND_GRID_OPACITY },
      surfaceMap: { value: surfaceMap },
      textureTile: { value: GROUND_TEXTURE_TILE_M },
    },
    defines: surfaceMap === null ? {} : { USE_SURFACE_MAP: 1 },
    depthTest: false,
    depthWrite: false,
    vertexShader: `
uniform mat4 inverseProjection;
uniform mat4 cameraWorld;
varying vec3 vRayNear;
varying vec3 vRayFar;
void main() {
  // 从裁剪空间还原近远两个世界点，透视相机与正交相机共用同一求交方式。
  // 四边形直接覆盖视口，不随沙盘大小增加几何数量。
  vec4 nearPoint = inverseProjection * vec4(position.xy, -1.0, 1.0);
  vec4 farPoint = inverseProjection * vec4(position.xy, 1.0, 1.0);
  vRayNear = (cameraWorld * vec4(nearPoint.xyz / nearPoint.w, 1.0)).xyz;
  vRayFar = (cameraWorld * vec4(farPoint.xyz / farPoint.w, 1.0)).xyz;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}`,
    fragmentShader: `
uniform vec3 groundColor;
uniform vec3 gridColor;
uniform vec3 pointColor;
uniform float groundHeight;
uniform vec4 groundBoundary;
uniform float fadeDistance;
uniform float panelSize;
uniform float seamWidth;
uniform float gridOpacity;
uniform sampler2D surfaceMap;
uniform float textureTile;
varying vec3 vRayNear;
varying vec3 vRayFar;
void main() {
  // 只填充朝向地面的射线，水平线上方继续显示原有场景背景。
  // 求交不受相机远裁剪面限制，高位缩远时不会再次露出纯黑边缘。
  vec3 ray = vRayFar - vRayNear;
  if (ray.y >= -0.00001) discard;
  float distanceToGround = (groundHeight - vRayNear.y) / ray.y;
  if (distanceToGround < 0.0) discard;
  vec2 worldPosition = (vRayNear + ray * distanceToGround).xz;
  vec3 color = groundColor;
  #ifdef USE_SURFACE_MAP
    color *= texture2D(surfaceMap, vec2(worldPosition.x, -worldPosition.y) / textureTile).rgb;
  #endif
  // 网格锚定世界原点，与内侧三米板缝保持同一尺度；亚像素线保持柔和覆盖率。
  // 远处格子不足两个像素时平滑淡出，避免低角度出现摩尔纹和闪烁。
  vec2 footprint = max(fwidth(worldPosition), vec2(0.0001));
  vec2 panelUv = fract(worldPosition / panelSize);
  vec2 seamDistance = min(panelUv, 1.0 - panelUv) * panelSize;
  vec2 lineWidth = max(vec2(seamWidth), footprint * 0.65);
  vec2 coverage = clamp((lineWidth * 0.5 - seamDistance) / footprint + 0.5, 0.0, 1.0)
    - clamp((-lineWidth * 0.5 - seamDistance) / footprint + 0.5, 0.0, 1.0);
  coverage *= 1.0 - smoothstep(vec2(panelSize * 0.25), vec2(panelSize * 0.5), footprint);
  float grid = 1.0 - (1.0 - coverage.x) * (1.0 - coverage.y);
  // 外部细线在墨蓝底色上轻微提亮，远处衰减为空间背景，避免无限密集的地平线。
  // 沙盘外沿按真实包围盒生成接触暗部，让下沉网格与底座之间有明确高度层次。
  float viewDistance = length(worldPosition - vRayNear.xz);
  float distanceFade = 1.0 - smoothstep(fadeDistance * 0.25, fadeDistance, viewDistance);
  vec2 outside = max(max(groundBoundary.xz - worldPosition, worldPosition - groundBoundary.yw), vec2(0.0));
  float edgeDistance = length(outside);
  float contact = 1.0 - exp(-edgeDistance * 0.65) * 0.68;
  color = mix(color, gridColor, grid * gridOpacity * distanceFade);
  color *= contact;
  // 固定格点哈希只点亮少量交点，静态分布不会随相机移动或资源重建而跳动。
  // 光点采用像素足迹过滤，极远处随网格淡出，不增加精灵或逐帧动画。
  vec2 gridPoint = floor(worldPosition / panelSize + 0.5);
  float pointSeed = fract(sin(dot(gridPoint, vec2(127.1, 311.7))) * 43758.5453);
  float pointMask = step(0.73, pointSeed);
  vec2 pointOffset = (worldPosition - gridPoint * panelSize) / max(vec2(0.04), footprint * 0.8);
  float pointCore = exp(-dot(pointOffset, pointOffset) * 1.8);
  float pointHalo = exp(-dot(pointOffset, pointOffset) * 0.22) * 0.14;
  float pointFade = 1.0 - smoothstep(panelSize * 0.08, panelSize * 0.3, max(footprint.x, footprint.y));
  color += pointColor * (pointCore + pointHalo) * pointMask * pointFade * distanceFade * contact * 0.85;
  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'map-exterior-ground'
  mesh.frustumCulled = false
  mesh.renderOrder = -1000
  mesh.userData['excludeFromGroundReflection'] = true
  /**
   * 背景不参与拾取或深度写入，车辆交互及内部地板继续由原有实体处理。
   * 每次绘制读取当前相机矩阵，避免切换视角后网格滞后一帧。
   */
  mesh.raycast = () => {}
  mesh.onBeforeRender = (_renderer, _scene, camera) => {
    material.uniforms['inverseProjection']!.value.copy(camera.projectionMatrixInverse)
    material.uniforms['cameraWorld']!.value.copy(camera.matrixWorld)
  }
  let disposed = false
  return {
    mesh,
    dispose() {
      if (disposed) return
      disposed = true
      geometry.dispose()
      material.dispose()
    },
  }
}
