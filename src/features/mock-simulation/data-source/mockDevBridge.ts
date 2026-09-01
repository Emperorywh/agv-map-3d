/**
 * Mock 开发控制桥（SPEC §9.3「window.__AGV_MOCK__ 只在开发和 Mock 模式暴露，
 * 可修改车辆数、种子、事件开关和模拟暂停状态；生产 WS 模式不得暴露」；
 * TASK-009）。
 *
 * 职责：把 MockVehicleDataSource 的开发控制接口以 `__AGV_MOCK__` 键挂到指定
 *       全局对象上，供开发期与自动化自测在浏览器控制台观察/操纵仿真。
 * 边界：本模块只做「有条件的一次赋值」——是否处于开发模式由调用方（app 组
 *       合层的 selectVehicleDataSource）以 import.meta.env.DEV 判定后注入；
 *       生产构建中该常量被静态替换为 false，桥挂载代码被死代码消除，因此
 *       生产产物既不注册也不会出现 Mock 全局。
 * 关键不变量：
 * 1. dev=false 时绝不写入目标对象（保证生产 WS 构建、生产 Mock 配置均无
 *    Mock 全局）；
 * 2. 桥只暴露读数与命令接口（MockDevControl），不泄漏内核内部状态、数据源
 *    引用或事件订阅通道——控制台无法经它绕过数据源合同直接注入事件；
 * 3. 写入目标可注入：测试用隔离对象验证挂载行为，不污染真实 globalThis。
 */

/** 开发桥在全局对象上的键名（SPEC §9.3 固定 __AGV_MOCK__） */
export const MOCK_DEV_BRIDGE_KEY = '__AGV_MOCK__'

/** 桥挂载目标的最小形态（window / globalThis / 测试隔离对象皆可） */
export type MockDevBridgeTarget = Record<string, unknown>

export interface RegisterMockDevBridgeOptions {
  /** 仅在开发模式为 true 时挂载（app 层以 import.meta.env.DEV 注入） */
  dev: boolean
  /** 挂载目标；缺省 globalThis */
  target?: MockDevBridgeTarget
}

/**
 * 把 Mock 开发控制接口挂载到目标全局对象。
 * dev=false 时为无操作（生产产物经死代码消除后连本调用也不会保留）。
 */
export function registerMockDevBridge(
  control: unknown,
  options: RegisterMockDevBridgeOptions,
): void {
  if (!options.dev) {
    return
  }
  const target = options.target ?? (globalThis as MockDevBridgeTarget)
  target[MOCK_DEV_BRIDGE_KEY] = control
}
