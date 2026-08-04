/**
 * Css2dLabelRendererAdapter 单元测试（SPEC §8.1、§8.2、§9.3、§10.1、§10.3）。
 *
 * node 环境以最小 FakeElement/桩件端口验证：容器覆盖与 pointer-events:none、
 * 同一 ResizeObserver 尺寸同步（0 维暂停 setSize/render）、DOM 池按 id 绑定/
 * 解绑复用（≤300、空闲池复用、textContent 写入、§8.2 固定样式）、完整清理
 * 与 StrictMode 幂等；默认端口用桩件全局 document/ResizeObserver + 真实
 * CSS2DRenderer/CSS2DObject 验证投影渲染行为（display/transform/容器挂载）。
 */

import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js'
import type { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js'
import { PerspectiveCamera, Scene } from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { LabelCategory, LabelMetadataDto } from '../../../application/factorySceneModel'
import { LABEL_ANCHOR_Y, LABEL_MAX_COUNT } from '../../../config/labelPolicy'
import {
  createCss2dLabelRendererAdapter,
  LABEL_ELEMENT_CLASS,
} from './Css2dLabelRendererAdapter'
import type { Css2dLabelRendererAdapter } from './Css2dLabelRendererAdapter'

// ---------------------------------------------------------------------------
// 最小 Fake DOM（仅实现 Adapter/CSS2DObject/CSS2DRenderer 触及的子集）
// ---------------------------------------------------------------------------

class FakeElement {
  readonly style: Record<string, string> = {}

  className = ''

  textContent = ''

  clientWidth = 0

  clientHeight = 0

  readonly children: FakeElement[] = []

  parentNode: FakeElement | null = null

  readonly attributes = new Map<string, unknown>()

  /** CSS2DObject removed 监听需要 ownerDocument.defaultView.Element 语义 */
  readonly ownerDocument = { defaultView: { Element: FakeElement } }

  appendChild(child: FakeElement): FakeElement {
    child.remove()
    this.children.push(child)
    child.parentNode = this
    return child
  }

  removeChild(child: FakeElement): FakeElement {
    const index = this.children.indexOf(child)
    if (index >= 0) {
      this.children.splice(index, 1)
      child.parentNode = null
    }
    return child
  }

  remove(): void {
    this.parentNode?.removeChild(this)
  }

  setAttribute(name: string, value: unknown): void {
    this.attributes.set(name, value)
  }
}

const asHtml = (element: FakeElement): HTMLElement => element as unknown as HTMLElement

function makeLabel(id: string, category: LabelCategory = 'node', x = 0, z = 0): LabelMetadataDto {
  return { id, category, text: `名称${id}`, worldPosition: [x, LABEL_ANCHOR_Y, z] }
}

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []

  readonly observed: unknown[] = []

  disconnected = false

  readonly callback: () => void

  constructor(callback: () => void) {
    this.callback = callback
    FakeResizeObserver.instances.push(this)
  }

  observe(target: unknown): void {
    this.observed.push(target)
  }

  disconnect(): void {
    this.disconnected = true
  }

  fire(): void {
    this.callback()
  }
}

/** 注入桩件端口的适配器夹具（默认端口测试之外的全部用例） */
function makeHarness(): {
  adapter: Css2dLabelRendererAdapter
  host: FakeElement
  setSize: ReturnType<typeof vi.fn>
  renderFn: ReturnType<typeof vi.fn>
  observer: FakeResizeObserver
  createdElements: FakeElement[]
} {
  const host = new FakeElement()
  host.clientWidth = 800
  host.clientHeight = 600
  const setSize = vi.fn()
  const renderFn = vi.fn()
  const createdElements: FakeElement[] = []
  let observer: FakeResizeObserver | null = null
  const adapter = createCss2dLabelRendererAdapter({
    createElement: () => {
      const element = new FakeElement()
      createdElements.push(element)
      return asHtml(element)
    },
    createRenderer: (container) => ({ domElement: container, setSize, render: renderFn }),
    createResizeObserver: (callback) => {
      observer = new FakeResizeObserver(callback)
      return observer
    },
  })
  adapter.mount(asHtml(host))
  return {
    adapter,
    host,
    setSize,
    renderFn,
    observer: observer as unknown as FakeResizeObserver,
    createdElements,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  FakeResizeObserver.instances = []
})

// ---------------------------------------------------------------------------
// §8.1 挂载与尺寸同步
// ---------------------------------------------------------------------------

describe('挂载与尺寸同步（§8.1/§1.4）', () => {
  it('mount：绝对定位容器追加到宿主并覆盖 canvas 区域，容器 pointer-events:none', () => {
    const { adapter, host, setSize, observer } = makeHarness()
    expect(host.children.length).toBe(1)
    const container = host.children[0]
    expect(adapter.container).toBe(asHtml(container))
    expect(container.style.position).toBe('absolute')
    expect(container.style.top).toBe('0px')
    expect(container.style.left).toBe('0px')
    expect(container.style.pointerEvents).toBe('none')
    // mount 即按宿主当前尺寸初始化
    expect(setSize).toHaveBeenCalledWith(800, 600)
    expect(observer.observed).toEqual([asHtml(host)])
  })

  it('同一 ResizeObserver 回调同步 CSS2D 尺寸；viewport 0 维跳过 setSize 并暂停 render', () => {
    const { adapter, host, setSize, renderFn, observer } = makeHarness()
    const scene = new Scene()
    const camera = new PerspectiveCamera()

    host.clientWidth = 1024
    host.clientHeight = 768
    observer.fire()
    expect(setSize).toHaveBeenLastCalledWith(1024, 768)

    // 0 维：跳过 setSize，render 暂停（§1.4）
    setSize.mockClear()
    host.clientWidth = 0
    observer.fire()
    expect(setSize).not.toHaveBeenCalled()
    adapter.render(scene, camera)
    expect(renderFn).not.toHaveBeenCalled()

    // 恢复正数：重新 setSize，render 恢复
    host.clientWidth = 640
    host.clientHeight = 600
    observer.fire()
    expect(setSize).toHaveBeenCalledWith(640, 600)
    adapter.render(scene, camera)
    expect(renderFn).toHaveBeenCalledTimes(1)
    expect(renderFn).toHaveBeenCalledWith(scene, camera)
  })

  it('重复 mount 幂等：不产生第二个容器（StrictMode）', () => {
    const { adapter, host } = makeHarness()
    adapter.mount(asHtml(host))
    expect(host.children.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// §8.1/§8.2 DOM 池与内容样式
// ---------------------------------------------------------------------------

describe('DOM 池（§8.1：≤300、按 id 绑定/解绑复用）', () => {
  it('attach：创建 .label 元素、textContent 写入文字、§8.2 固定样式、CSS2DObject 挂到场景', () => {
    const { adapter } = makeHarness()
    const scene = new Scene()
    const label = makeLabel('node:n1', 'node', 3, -4)
    expect(adapter.attach(label, scene)).toBe(true)

    expect(adapter.attachedCount).toBe(1)
    expect(adapter.pooledCount).toBe(1)
    expect(scene.children.length).toBe(1)
    const object = scene.children[0] as CSS2DObject
    expect(object.position.toArray()).toEqual([3, LABEL_ANCHOR_Y, -4])

    const element = object.element as unknown as FakeElement
    expect(element.className).toBe(LABEL_ELEMENT_CLASS)
    expect(element.className).toBe('label')
    expect(element.textContent).toBe('名称node:n1')
    // §8.2 固定样式：12px、#2B2F33、白底 rgba(255,255,255,0.78) 圆角 pill、pointer-events:none
    expect(element.style.fontSize).toBe('12px')
    expect(element.style.color).toBe('#2B2F33')
    expect(element.style.backgroundColor).toBe('rgba(255,255,255,0.78)')
    expect(element.style.borderRadius).toBe('999px')
    expect(element.style.pointerEvents).toBe('none')
  })

  it('同 id 重复 attach：复用同一元素（不新建），textContent 就地更新', () => {
    const { adapter } = makeHarness()
    const scene = new Scene()
    adapter.attach(makeLabel('node:n1'), scene)
    const renamed: LabelMetadataDto = { ...makeLabel('node:n1'), text: '改名' }
    adapter.attach(renamed, scene)
    expect(adapter.pooledCount).toBe(1)
    expect(adapter.attachedCount).toBe(1)
    expect(scene.children.length).toBe(1)
    expect(((scene.children[0] as CSS2DObject).element as unknown as FakeElement).textContent).toBe('改名')
  })

  it('detach：CSS2DObject 从场景摘除、元素从容器摘除并回空闲池；新 id 复用池元素', () => {
    const { adapter } = makeHarness()
    const scene = new Scene()
    adapter.attach(makeLabel('node:n1'), scene)
    adapter.attach(makeLabel('node:n2'), scene)
    expect(adapter.pooledCount).toBe(2)

    adapter.detach('node:n1')
    expect(adapter.attachedCount).toBe(1)
    expect(scene.children.length).toBe(1)

    // 空闲池复用：不新建元素
    adapter.attach(makeLabel('node:n3'), scene)
    expect(adapter.pooledCount).toBe(2)
    expect(adapter.attachedCount).toBe(2)
  })

  it('detach 未知 id：无操作', () => {
    const { adapter } = makeHarness()
    const scene = new Scene()
    adapter.attach(makeLabel('node:n1'), scene)
    adapter.detach('node:unknown')
    expect(adapter.attachedCount).toBe(1)
    expect(scene.children.length).toBe(1)
  })

  it('池上限 300：第 301 个 attach 返回 false 且不新建元素；detach 后可再绑定', () => {
    const { adapter } = makeHarness()
    const scene = new Scene()
    for (let i = 0; i < LABEL_MAX_COUNT; i += 1) {
      expect(adapter.attach(makeLabel(`node:n${i}`), scene)).toBe(true)
    }
    expect(adapter.attachedCount).toBe(LABEL_MAX_COUNT)
    expect(adapter.pooledCount).toBe(LABEL_MAX_COUNT)

    expect(adapter.attach(makeLabel('node:overflow'), scene)).toBe(false)
    expect(adapter.pooledCount).toBe(LABEL_MAX_COUNT)
    expect(adapter.attachedCount).toBe(LABEL_MAX_COUNT)

    adapter.detach('node:n0')
    expect(adapter.attach(makeLabel('node:overflow'), scene)).toBe(true)
    expect(adapter.pooledCount).toBe(LABEL_MAX_COUNT)
  })
})

// ---------------------------------------------------------------------------
// §8.1/§10.3 完整清理
// ---------------------------------------------------------------------------

describe('unmount 完整清理（§8.1/§10.3）', () => {
  it('dispose：断开 observer、容器移出宿主、全部 CSS2DObject 出场景、池清空；幂等', () => {
    const { adapter, host, observer } = makeHarness()
    const scene = new Scene()
    adapter.attach(makeLabel('node:n1'), scene)
    adapter.attach(makeLabel('node:n2'), scene)
    adapter.detach('node:n2') // 空闲池一项

    adapter.dispose()
    expect(observer.disconnected).toBe(true)
    expect(host.children.length).toBe(0)
    expect(scene.children.length).toBe(0)
    expect(adapter.container).toBeNull()
    expect(adapter.attachedCount).toBe(0)
    expect(adapter.pooledCount).toBe(0)

    adapter.dispose() // 幂等
    expect(host.children.length).toBe(0)
  })

  it('dispose 后可重新 mount（StrictMode 卸载-重挂周期）：任一时刻恰一个容器', () => {
    const { adapter, host, createdElements } = makeHarness()
    const firstContainer = adapter.container
    adapter.dispose()
    adapter.mount(asHtml(host))
    expect(host.children.length).toBe(1)
    expect(adapter.container).not.toBe(firstContainer)
    expect(createdElements.length).toBe(2) // 两个容器元素（第一次挂载 + 重新挂载）
  })

  it('dispose 后异步到达的 observer 回调安全无操作（不触碰已释放 renderer）', () => {
    const { adapter, observer, setSize } = makeHarness()
    adapter.dispose()
    setSize.mockClear()
    observer.fire()
    expect(setSize).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 默认端口：真实 CSS2DRenderer / CSS2DObject（桩件全局 document/ResizeObserver）
// ---------------------------------------------------------------------------

describe('默认端口集成（真实 CSS2DRenderer，§8.1 投影行为）', () => {
  function makeDefaultAdapter(): { adapter: Css2dLabelRendererAdapter, host: FakeElement } {
    const host = new FakeElement()
    host.clientWidth = 800
    host.clientHeight = 600
    vi.stubGlobal('document', { createElement: () => asHtml(new FakeElement()) })
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    const adapter = createCss2dLabelRendererAdapter()
    adapter.mount(asHtml(host))
    return { adapter, host }
  }

  it('容器交给真实 CSS2DRenderer；render 后标签元素进入容器并写入 display/transform', () => {
    const { adapter, host } = makeDefaultAdapter()
    const scene = new Scene()
    // 标签位于原点，相机 (0,0.5,20) 直视 → 可见；另一个在相机背后 → display:none
    adapter.attach(makeLabel('node:front', 'node', 0, 0), scene)
    adapter.attach(makeLabel('node:back', 'node', 0, 100), scene)
    const camera = new PerspectiveCamera(46, 800 / 600, 0.1, 2000)
    camera.position.set(0, 0.5, 20)
    camera.up.set(0, 1, 0)
    camera.lookAt(0, 0.5, 0)

    const container = host.children[0]
    expect(adapter.container).toBe(asHtml(container))
    adapter.render(scene, camera)

    const front = (scene.children[0] as CSS2DObject).element as unknown as FakeElement
    const back = (scene.children[1] as CSS2DObject).element as unknown as FakeElement
    // CSS2DRenderer 仅把可见标签挂入容器；不可见标签 display:none 且不挂载
    expect(container.children).toContain(front)
    expect(container.children).not.toContain(back)
    expect(front.style.display).toBe('')
    expect(front.style.transform).toContain('translate(')
    expect(back.style.display).toBe('none')
    adapter.dispose()
  })

  it('detach 后元素从真实渲染容器摘除', () => {
    const { adapter, host } = makeDefaultAdapter()
    const scene = new Scene()
    adapter.attach(makeLabel('node:n1'), scene)
    const camera = new PerspectiveCamera(46, 800 / 600, 0.1, 2000)
    camera.position.set(0, 0.5, 20)
    camera.lookAt(0, 0.5, 0)
    adapter.render(scene, camera)
    const container = host.children[0]
    const element = (scene.children[0] as CSS2DObject).element as unknown as FakeElement
    expect(container.children).toContain(element)

    adapter.detach('node:n1')
    expect(container.children).not.toContain(element)
    expect(element.parentNode).toBeNull()
    adapter.dispose()
  })

  it('真实 CSS2DRenderer 可由默认 createRenderer 创建（three 同版本 addons）', () => {
    const renderer = new CSS2DRenderer({ element: asHtml(new FakeElement()) })
    expect(renderer.domElement).toBeDefined()
  })
})
