/**
 * 唯一的鼠标会话所有者：按下、移动、滚轮、捕获释放全部在这里配对。
 * 只输出手势意图，不直接写相机，也不依赖第三方控制器代为捕获指针。
 */
export type NavigationGesture = 'rotate' | 'pan' | 'dolly'

export interface NavigationInputHandler {
  enabled(gesture?: NavigationGesture): boolean
  interact(): void
  drag(gesture: NavigationGesture, x: number, y: number, lastX: number, lastY: number, dx: number, dy: number, travel: number): void
  wheel(x: number, y: number, delta: number): void
  overview(): void
}

interface PointerSession {
  pointerId: number
  gesture: NavigationGesture
  buttonMask: number
  x: number
  y: number
  lastX: number
  lastY: number
  travel: number
}

export function bindNavigationInput(element: HTMLElement, handler: NavigationInputHandler) {
  const ownerDocument = element.ownerDocument
  const ownerWindow = ownerDocument.defaultView!
  const originalCursor = element.style.cursor
  const originalTouchAction = element.style.touchAction
  let session: PointerSession | null = null
  let suppressClick = false
  element.style.touchAction = 'none'

  /**
   * 先清空会话再释放捕获，避免同步的捕获丢失事件再次结束同一次拖动。
   * 文档级移动和抬起监听兜底画布外释放，窗口失焦和页面隐藏也走相同出口。
   */
  const cancel = (): void => {
    const previous = session
    session = null
    element.style.cursor = originalCursor
    if (previous !== null && element.hasPointerCapture(previous.pointerId)) {
      element.releasePointerCapture(previous.pointerId)
    }
  }
  const onDown = (event: PointerEvent): void => {
    if (event.pointerType !== 'mouse' || !event.isPrimary) return
    suppressClick = false
    if (!handler.enabled()) return
    const gesture = event.button === 2 || (event.button === 0 && (event.ctrlKey || event.metaKey || event.shiftKey))
      ? 'pan' : event.button === 0 ? 'rotate' : event.button === 1 ? 'dolly' : null
    if (gesture === null || !handler.enabled(gesture)) return
    cancel()
    handler.interact()
    session = {
      pointerId: event.pointerId, gesture, buttonMask: event.button === 0 ? 1 : event.button === 2 ? 2 : 4,
      x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY, travel: 0,
    }
    element.setPointerCapture(event.pointerId)
    element.style.cursor = gesture === 'dolly' ? 'ns-resize' : 'grabbing'
    if (event.button !== 0) event.preventDefault()
  }
  const onMove = (event: PointerEvent): void => {
    const current = session
    if (current === null || current.pointerId !== event.pointerId) return
    /**
     * 鼠标多键交替时不一定会产生新的 pointerdown，必须检查实际按键位图。
     * 原按钮松开但另一按钮仍按住时，在当前位置交接手势，不要求用户再松开重按。
     */
    if (!handler.enabled(current.gesture) || event.buttons === 0) {
      cancel()
      return
    }
    if ((event.buttons & current.buttonMask) === 0) {
      const buttonMask = event.buttons & 2 ? 2 : event.buttons & 1 ? 1 : event.buttons & 4 ? 4 : 0
      const gesture = buttonMask === 2 || (buttonMask === 1 && (event.ctrlKey || event.metaKey || event.shiftKey))
        ? 'pan' : buttonMask === 1 ? 'rotate' : 'dolly'
      if (buttonMask === 0 || !handler.enabled(gesture)) {
        cancel()
        return
      }
      current.buttonMask = buttonMask
      current.gesture = gesture
      current.x = current.lastX = event.clientX
      current.y = current.lastY = event.clientY
      element.style.cursor = gesture === 'dolly' ? 'ns-resize' : 'grabbing'
      return
    }
    const dx = event.clientX - current.lastX
    const dy = event.clientY - current.lastY
    current.travel = Math.max(current.travel, Math.hypot(event.clientX - current.x, event.clientY - current.y))
    if (current.travel > 6) suppressClick = true
    if (dx !== 0 || dy !== 0) {
      handler.drag(current.gesture, current.x, current.y, current.lastX, current.lastY, dx, dy, current.travel)
    }
    current.lastX = event.clientX
    current.lastY = event.clientY
  }
  const onUp = (event: PointerEvent): void => {
    if (session?.pointerId === event.pointerId) cancel()
  }
  const onVisibility = (): void => {
    if (ownerDocument.hidden) cancel()
  }
  const onContextMenu = (event: MouseEvent): void => {
    if (handler.enabled()) event.preventDefault()
  }
  const onClick = (event: MouseEvent): void => {
    /**
     * 记录整次拖动的最大位移，拖出去再拖回原点也不能误触车辆单击或双击。
     * 下一次真正按下会重置标记，普通选择仍由场景自身处理。
     */
    if (suppressClick) {
      event.preventDefault()
      event.stopImmediatePropagation()
    }
  }
  const onWheel = (event: WheelEvent): void => {
    if (!handler.enabled('dolly')) return
    event.preventDefault()
    handler.interact()
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1
    const delta = event.deltaY * unit * (event.ctrlKey ? 10 : 1)
    if (!Number.isFinite(delta) || delta === 0) return
    /**
     * 滚轮可以穿插于拖动；几何层每次读取实际机位，因此无需保留过期的地面锚点。
     * 更新屏幕基准后继续当前手势，避免缩放后第一步拖动跳回旧坐标。
     */
    handler.wheel(event.clientX, event.clientY, delta)
    if (session !== null) {
      suppressClick = true
      session.x = event.clientX
      session.y = event.clientY
      session.lastX = event.clientX
      session.lastY = event.clientY
    }
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (!handler.enabled() || event.defaultPrevented || event.repeat || event.code !== 'Space' || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return
    const target = event.target as HTMLElement | null
    if (target?.isContentEditable || target?.closest('input, textarea, select, button, a, [role="textbox"], [role="button"]')) return
    event.preventDefault()
    cancel()
    handler.interact()
    handler.overview()
  }

  /**
   * 画布捕获阶段先提交相机，随后场景拾取使用同一机位，正常事件继续传播。
   * 所有监听具有对称卸载路径，严格模式重挂载不会叠加缩放或拖拽响应。
   */
  element.addEventListener('pointerdown', onDown, true)
  ownerDocument.addEventListener('pointermove', onMove, true)
  ownerDocument.addEventListener('pointerup', onUp, true)
  ownerDocument.addEventListener('pointercancel', onUp, true)
  element.addEventListener('lostpointercapture', onUp)
  element.addEventListener('wheel', onWheel, { passive: false, capture: true })
  element.addEventListener('contextmenu', onContextMenu)
  element.addEventListener('click', onClick, true)
  element.addEventListener('dblclick', onClick, true)
  ownerDocument.addEventListener('visibilitychange', onVisibility)
  ownerWindow.addEventListener('blur', cancel)
  ownerWindow.addEventListener('keydown', onKeyDown)
  return {
    cancel,
    dispose(): void {
      cancel()
      element.removeEventListener('pointerdown', onDown, true)
      ownerDocument.removeEventListener('pointermove', onMove, true)
      ownerDocument.removeEventListener('pointerup', onUp, true)
      ownerDocument.removeEventListener('pointercancel', onUp, true)
      element.removeEventListener('lostpointercapture', onUp)
      element.removeEventListener('wheel', onWheel, true)
      element.removeEventListener('contextmenu', onContextMenu)
      element.removeEventListener('click', onClick, true)
      element.removeEventListener('dblclick', onClick, true)
      ownerDocument.removeEventListener('visibilitychange', onVisibility)
      ownerWindow.removeEventListener('blur', cancel)
      ownerWindow.removeEventListener('keydown', onKeyDown)
      element.style.touchAction = originalTouchAction
    },
  }
}
