/**
 * mock-simulation Feature 公开入口（SPEC §9、§12.2～§12.4；TASK-008）。
 *
 * 职责：向 app 组合层与 TASK-009 的 Mock 数据源暴露最小稳定合同：确定性
 *       仿真内核（车队分配/推进/寻充/死路停车）、有向 Dijkstra 寻路、
 *       弧长遍历表、速度裁决与固定种子 PRNG 原语。TASK-009 的
 *       MockVehicleDataSource 以此内核为引擎产出归一化 VehicleDataEvent。
 * 边界：外部模块只允许从这里导入本 Feature；内部文件（model 细分模块）
 *       不对 Feature 外暴露。本 Feature 只允许依赖 map-visualization 与
 *       fleet-monitoring 的公开入口（依赖边界由 .dependency-cruiser.cjs
 *       锁定）。TASK-008 不含计时器、数据源生命周期、React 或 Three 对象。
 * 关键不变量：
 * 1. 可复现：内核与 PRNG 的全部随机决策由固定种子决定，同一输入同一调用
 *    序列必然全等复现（SPEC §9.3）；
 * 2. 只读视图：getVehicleStates() 零拷贝暴露内部领域状态，消费方（TASK-009）
 *    在发布 VehicleDataEvent 前必须复制为不可变 VehicleSnapshot；
 * 3. 拓扑守恒与安全停车：车辆终生不离开所属弱连通分量的有向边；死路/无
 *    充电路径安全停车并携带 Mock 数据告警，绝不瞬移或跨分量传送。
 */
export { createMockPrng, DEFAULT_MOCK_SEED, randomInRange, randomInt } from './model/prng'
export type { MockPrng } from './model/prng'
export {
  findDirectedPath,
  findNearestChargePath,
} from './model/pathfinding'
export type { MockPathResult } from './model/pathfinding'
export { createEdgeTraverseTable } from './model/arcLengthTable'
export type { ArcLengthSample, EdgeTraverseTable } from './model/arcLengthTable'
export {
  MOCK_SPEED_MAX_MPS,
  MOCK_SPEED_MIN_MPS,
  resolveCruiseSpeed,
  resolveEdgeSpeedLimit,
  sampleTargetSpeed,
} from './model/motion'
export {
  allocateByEdgeProportion,
  createMockSimulationKernel,
  MAX_EDGE_TRANSITIONS_PER_STEP,
  MOCK_CHARGE_TARGET_PERCENT,
  MOCK_LOW_BATTERY_SEEK_PERCENT,
} from './model/simulationKernel'
export type {
  MockSimulationKernel,
  MockSimulationOptions,
  MockVehicleAlertCode,
  MockVehicleBlockedReason,
  MockVehicleMode,
  MockVehicleRuntimeState,
  ResolvedMockSimulationConfig,
} from './model/simulationKernel'
