/**
 * 静态箭头合批的屏幕尺寸淡出材质：按每枚箭头首尾的实际投影计算像素长度。
 * 使用裁剪坐标同时兼容透视与正交相机，倾斜观察时也考虑箭头的透视缩短。
 * 箭头颜色由几何的逐顶点色承载（默认暖白 / isBackEdge 红色），材质只负责
 * 统一提亮；只更新视口 uniform，几何属性始终静态，维持一个箭头绘制批次。
 */
import * as THREE from 'three'
import {
  PATH_DIRECTION_ARROW_BOOST,
  PATH_DIRECTION_ARROW_FADE_END_PX,
  PATH_DIRECTION_ARROW_FADE_START_PX,
} from './mapAppearance'

export function createPathArrowMaterial(): {
  material: THREE.MeshBasicMaterial
  viewport: THREE.Vector2
} {
  const viewport = new THREE.Vector2()
  const material = new THREE.MeshBasicMaterial({
    color: new THREE.Color(1, 1, 1).multiplyScalar(PATH_DIRECTION_ARROW_BOOST),
    vertexColors: true,
    side: THREE.DoubleSide,
    toneMapped: false,
    transparent: true,
    depthWrite: false,
    /**
     * 箭头是平面贴花，双面透明仅需一次绘制，避免默认背面/正面双通道翻倍。
     * 方向标记互不重叠，因此单次绘制保持正确外观。
     */
    forceSinglePass: true,
  })
  material.name = 'map-path-arrow-lod'
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uArrowViewportPx = { value: viewport }
    shader.uniforms.uArrowFadeEndPx = { value: PATH_DIRECTION_ARROW_FADE_END_PX }
    shader.uniforms.uArrowFadeStartPx = { value: PATH_DIRECTION_ARROW_FADE_START_PX }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', [
        '#include <common>',
        'attribute vec3 aArrowCenter;',
        'attribute vec3 aArrowSpan;',
        'attribute vec3 aArrowPartnerCenter;',
        'attribute vec3 aArrowPartnerSpan;',
        'uniform vec2 uArrowViewportPx;',
        'varying float vArrowLengthPx;',
        '/**',
        ' * 同一双向组使用两枚投影长度的较小值，始终一起显隐。',
        ' * 用首尾裁剪坐标计算屏幕长度，兼容正交与透视投影。',
        ' */',
        'float arrowScreenLength( vec3 center, vec3 span ) {',
        '  vec4 start = projectionMatrix * modelViewMatrix * vec4( center - span, 1.0 );',
        '  vec4 end = projectionMatrix * modelViewMatrix * vec4( center + span, 1.0 );',
        '  vec2 delta = end.xy / max( end.w, 0.0001 ) - start.xy / max( start.w, 0.0001 );',
        '  return length( delta * uArrowViewportPx * 0.5 );',
        '}',
      ].join('\n'))
      .replace('#include <project_vertex>', [
        '#include <project_vertex>',
        'vArrowLengthPx = min( arrowScreenLength( aArrowCenter, aArrowSpan ), arrowScreenLength( aArrowPartnerCenter, aArrowPartnerSpan ) );',
      ].join('\n'))
    /**
     * 全透明片元直接丢弃，中间态不写深度，避免淡出的贴花遮挡后方内容。
     * 双向箭头从几何布局到投影淡出都成组处理，保持通行方向的表达一致。
     */
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', [
        '#include <common>',
        'uniform float uArrowFadeEndPx;',
        'uniform float uArrowFadeStartPx;',
        'varying float vArrowLengthPx;',
      ].join('\n'))
      .replace('#include <opaque_fragment>', [
        '#include <opaque_fragment>',
        'float arrowFade = smoothstep( uArrowFadeEndPx, uArrowFadeStartPx, vArrowLengthPx );',
        'if ( arrowFade <= 0.003 ) discard;',
        'gl_FragColor.a *= arrowFade;',
      ].join('\n'))
  }
  material.customProgramCacheKey = () => 'map-path-arrow-lod-v2'
  return { material, viewport }
}
