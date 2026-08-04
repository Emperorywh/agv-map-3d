/**
 * Css2dLabelRendererAdapter：CSS2DRenderer 独占封装（SPEC §8.1、§8.2、§9.3、§10.1、§10.3）。
 *
 * - 使用与 three 同版本的 three/addons/renderers/CSS2DRenderer.js（§2/§8.1），
 *   不使用 drei Html；绝对定位容器覆盖 WebGL canvas（追加到 canvas 的父宿主，
 *   §1.4 同一个 position:relative 宿主），容器与标签统一 pointer-events:none（§9.3）；
 * - 尺寸同步：Adapter 持有本组件唯一一个 ResizeObserver 观察宿主——宿主即 R3F
 *   Canvas 的容器，WebGL 侧由 R3F 对同一宿主的观察同步 setSize，CSS2D 侧由本
 *   observer 回调 setSize，两侧因此始终使用同一宿主尺寸；viewport 任一维为 0
 *   时跳过 setSize 并暂停 CSS2D render（§1.4），恢复正数后下一帧重投影；
 * - DOM 池（§8.1/§10.1）：最多创建 LABEL_MAX_COUNT=300 个元素，按 label id
 *   绑定/解绑复用——解绑元素进入空闲池（DOM 摘除，不保留隐藏 DOM），绑定优先
 *   复用空闲元素，不为全量节点创建 DOM；
 * - 内容只通过 textContent 写入（§8.2，禁止 innerHTML）；样式固定 12px、
 *   #2B2F33、白底 rgba(255,255,255,0.78) 圆角 pill；屏幕恒定字号——不做任何
 *   随距离的缩放变换（CSS2DRenderer 仅平移）；
 * - 每个实际重绘帧在 WebGL 完成后由 LabelLayer 调用一次 render（§8.1/§5.2）；
 * - unmount 完整清理（§8.1/§10.3）：移除容器、断开 ResizeObserver、全部
 *   CSS2DObject 从场景摘除、DOM 池清空；setup/cleanup 幂等，StrictMode 重复
 *   挂载不产生重复容器。
 *
 * node 环境可测：renderer / 元素创建 / ResizeObserver 均可注入（默认实现走
 * 真实 CSS2DRenderer 与 DOM）；CSS2DObject 始终使用 three 真实实现。
 */

import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js'
import type { Camera, Object3D } from 'three'

import type { LabelMetadataDto } from '../../../application/factorySceneModel'
import { LABEL_MAX_COUNT } from '../../../config/labelPolicy'

// ---------------------------------------------------------------------------
// §8.2 固定样式（SPEC 钉死值；padding/whiteSpace 为 v1 观感取值，SPEC 未固定）
// ---------------------------------------------------------------------------

const LABEL_FONT_SIZE = '12px'
const LABEL_TEXT_COLOR = '#2B2F33'
const LABEL_BACKGROUND = 'rgba(255,255,255,0.78)'
/** 圆角 pill：足够大的半径形成胶囊形 */
const LABEL_BORDER_RADIUS = '999px'
/** v1 观感取值（SPEC 未固定）：pill 内边距与单行不换行 */
const LABEL_PADDING = '2px 8px'
const LABEL_WHITE_SPACE = 'nowrap'

/** 标签元素 class：§10.1 DOM 预算与验收计数（DevTools 计数 .label 元素）的锚点 */
export const LABEL_ELEMENT_CLASS = 'label'

// ---------------------------------------------------------------------------
// 可注入端口（生产默认实现走真实 DOM/CSS2DRenderer；测试注入桩件）
// ---------------------------------------------------------------------------

/** CSS2DRenderer 最小端口（与 three CSS2DRenderer 结构一致） */
export interface Css2dRendererPort {
  readonly domElement: HTMLElement
  setSize(width: number, height: number): void
  render(scene: Object3D, camera: Camera): void
}

/** ResizeObserver 最小端口 */
export interface ResizeObserverPort {
  observe(target: HTMLElement): void
  disconnect(): void
}

export interface Css2dLabelRendererAdapterOptions {
  /** 默认：new CSS2DRenderer({ element: container })（three 同版本 addons，§8.1） */
  readonly createRenderer?: (container: HTMLElement) => Css2dRendererPort
  /** 默认：document.createElement */
  readonly createElement?: (tagName: 'div') => HTMLElement
  /** 默认：new ResizeObserver(callback)（Adapter 内唯一 observer，§8.1） */
  readonly createResizeObserver?: (callback: () => void) => ResizeObserverPort
}

export interface Css2dLabelRendererAdapter {
  /**
   * 挂载到宿主（WebGL canvas 的父元素）：创建绝对定位容器、CSS2DRenderer 与
   * ResizeObserver，并按宿主当前尺寸初始化；幂等——重复 mount 不产生第二个容器。
   */
  mount(host: HTMLElement): void
  /**
   * 绑定标签：同 id 复用已绑定元素；否则取空闲池元素或新建（池满 300 返回
   * false 不绑定）。文字经 textContent 写入，锚点取自元数据 worldPosition。
   */
  attach(label: LabelMetadataDto, scene: Object3D): boolean
  /** 解绑标签：CSS2DObject 从场景摘除、元素从容器摘除并回空闲池；未知 id 无操作 */
  detach(id: string): void
  /** 每个实际重绘帧在 WebGL 完成后调用一次（§8.1）；尺寸无效（0 维）时暂停 */
  render(scene: Object3D, camera: Camera): void
  /** 完整清理：容器/ResizeObserver/CSS2DObject/DOM 池；幂等，清理后可重新 mount */
  dispose(): void
  /** CSS2D 容器（renderer.domElement；未挂载为 null） */
  readonly container: HTMLElement | null
  /** 当前绑定的标签数（= 文档内 .label 元素数） */
  readonly attachedCount: number
  /** 池已创建元素总数（绑定 + 空闲，≤ LABEL_MAX_COUNT） */
  readonly pooledCount: number
}

interface PoolEntry {
  readonly element: HTMLElement
  readonly object: CSS2DObject
}

const defaultCreateRenderer = (container: HTMLElement): Css2dRendererPort =>
  new CSS2DRenderer({ element: container })

const defaultCreateElement = (tagName: 'div'): HTMLElement => document.createElement(tagName)

const defaultCreateResizeObserver = (callback: () => void): ResizeObserverPort =>
  new ResizeObserver(callback)

export function createCss2dLabelRendererAdapter(
  options: Css2dLabelRendererAdapterOptions = {},
): Css2dLabelRendererAdapter {
  const createRenderer = options.createRenderer ?? defaultCreateRenderer
  const createElement = options.createElement ?? defaultCreateElement
  const createResizeObserver = options.createResizeObserver ?? defaultCreateResizeObserver

  let host: HTMLElement | null = null
  let container: HTMLElement | null = null
  let renderer: Css2dRendererPort | null = null
  let observer: ResizeObserverPort | null = null
  let sizeValid = false

  const bound = new Map<string, PoolEntry>()
  const free: PoolEntry[] = []
  let pooled = 0

  /** §8.2 固定标签样式（创建时写入一次；元素复用不重复写入） */
  const applyLabelStyle = (element: HTMLElement): void => {
    const { style } = element
    style.fontSize = LABEL_FONT_SIZE
    style.color = LABEL_TEXT_COLOR
    style.backgroundColor = LABEL_BACKGROUND
    style.borderRadius = LABEL_BORDER_RADIUS
    style.padding = LABEL_PADDING
    style.whiteSpace = LABEL_WHITE_SPACE
    style.pointerEvents = 'none'
  }

  const createEntry = (): PoolEntry | null => {
    if (pooled >= LABEL_MAX_COUNT) return null
    const element = createElement('div')
    element.className = LABEL_ELEMENT_CLASS
    applyLabelStyle(element)
    pooled += 1
    return { element, object: new CSS2DObject(element) }
  }

  /** 尺寸同步（observer 回调与 mount 初始化共用）：0 维跳过 setSize 并暂停 render（§1.4） */
  const syncSize = (): void => {
    if (host === null || renderer === null) return
    const width = host.clientWidth
    const height = host.clientHeight
    if (width <= 0 || height <= 0) {
      sizeValid = false
      return
    }
    sizeValid = true
    renderer.setSize(width, height)
  }

  return {
    mount(target: HTMLElement): void {
      if (container !== null) return // 幂等：StrictMode 重复挂载不产生第二个容器
      host = target
      const element = createElement('div')
      element.style.position = 'absolute'
      element.style.top = '0px'
      element.style.left = '0px'
      element.style.pointerEvents = 'none'
      container = element
      renderer = createRenderer(element)
      observer = createResizeObserver(syncSize)
      target.appendChild(element)
      observer.observe(target)
      syncSize()
    },

    attach(label: LabelMetadataDto, scene: Object3D): boolean {
      let entry = bound.get(label.id)
      if (entry === undefined) {
        entry = free.pop() ?? createEntry() ?? undefined
        if (entry === undefined) return false
        bound.set(label.id, entry)
      }
      // §8.2：内容只通过 textContent 写入；显示文字只用 name（元数据 text）
      entry.element.textContent = label.text
      const [x, y, z] = label.worldPosition
      entry.object.position.set(x, y, z)
      scene.add(entry.object)
      return true
    },

    detach(id: string): void {
      const entry = bound.get(id)
      if (entry === undefined) return
      bound.delete(id)
      entry.object.removeFromParent()
      entry.element.remove()
      free.push(entry)
    },

    render(scene: Object3D, camera: Camera): void {
      if (renderer === null || !sizeValid) return
      renderer.render(scene, camera)
    },

    dispose(): void {
      observer?.disconnect()
      observer = null
      for (const entry of bound.values()) {
        entry.object.removeFromParent()
        entry.element.remove()
      }
      bound.clear()
      // 空闲池元素在 detach 时已从 DOM 摘除，此处仅释放引用
      free.length = 0
      pooled = 0
      container?.remove()
      container = null
      renderer = null
      host = null
      sizeValid = false
    },

    get container(): HTMLElement | null {
      return container
    },

    get attachedCount(): number {
      return bound.size
    },

    get pooledCount(): number {
      return pooled
    },
  }
}
