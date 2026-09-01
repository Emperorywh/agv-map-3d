/**
 * mock-simulation Feature 公开入口（SPEC §9、§12.2～§12.4；TASK-008/009）。
 *
 * 职责：向 app 组合层暴露最小稳定合同：确定性仿真内核（车队分配/推进/寻充/
 *       死路停车/动态增删车）、有向 Dijkstra 寻路、弧长遍历表、速度裁决、
 *       固定种子 PRNG 原语、交通矩形纯几何、确定性验收场景调度器，以及
 *       TASK-009 的 MockVehicleDataSource 工厂与开发桥注册入口。
 * 边界：外部模块只允许从这里导入本 Feature；内部文件（model/data-source/
 *       scenarios 细分模块）不对 Feature 外暴露。本 Feature 只允许依赖
 *       map-visualization 与 fleet-monitoring 的公开入口（依赖边界由
 *       .dependency-cruiser.cjs 锁定）。不含 React/Three 对象；计时器只存在
 *       于数据源生命周期内。
 * 关键不变量：
 * 1. 可复现：内核、场景与数据源的全部随机决策由固定种子与调用顺序决定，
 *    同一输入同一调用序列必然全等复现（SPEC §9.3）；
 * 2. 事件合同：MockVehicleDataSource 产出的全部车辆负载经 fleet-monitoring
 *    公开的 validateVehicle 同一校验路径归一化（与真实 WS 同一事件合同）；
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
  formatMockAgvKey,
  MAX_EDGE_TRANSITIONS_PER_STEP,
  MOCK_CHARGE_TARGET_PERCENT,
  MOCK_LOW_BATTERY_SEEK_PERCENT,
  parseMockAgvSerial,
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
export {
  buildPathAlignedQuad,
  buildTrafficRectangles,
  TRAFFIC_APPLYING_STEP_ONE_M,
  TRAFFIC_APPLYING_STEP_TWO_M,
  TRAFFIC_LOCKED_MARGIN_M,
} from './model/trafficRectangle'
export type {
  TrafficQuadAnchor,
  TrafficRectangles,
  TrafficRectanglesOptions,
} from './model/trafficRectangle'
export {
  ACCEPTANCE_TARGET_SERIAL_BASE,
  createAcceptanceScenario,
  DEFAULT_ACCEPTANCE_WINDOW_SECONDS,
} from './scenarios/acceptanceScenario'
export type {
  AcceptanceScenario,
  CreateAcceptanceScenarioOptions,
  MockScenarioDirective,
  MockScenarioPatch,
} from './scenarios/acceptanceScenario'
export { createMockVehicleDataSource } from './data-source/MockVehicleDataSource'
export type {
  MockDataSourceStats,
  MockDevControl,
  MockVehicleDataSource,
  MockVehicleDataSourceOptions,
} from './data-source/MockVehicleDataSource'
export {
  MOCK_ACCEPTANCE_WINDOW_SECONDS,
  MOCK_BASE_INTERVAL_MS,
  MOCK_DEFAULT_VEHICLE_COUNT,
  MOCK_HEARTBEAT_INTERVAL_MS,
  MOCK_LOW_BATTERY_VEHICLE_COUNT,
  MOCK_PRESSURE_VEHICLE_COUNT,
  MOCK_SCHEMA_VERSION,
} from './data-source/MockVehicleDataSource'
export { MOCK_DEV_BRIDGE_KEY, registerMockDevBridge } from './data-source/mockDevBridge'
export type {
  MockDevBridgeTarget,
  RegisterMockDevBridgeOptions,
} from './data-source/mockDevBridge'
