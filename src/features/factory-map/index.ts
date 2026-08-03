/**
 * factory-map 功能模块唯一公开出口（SPEC §12）。
 * 功能目录外的代码只允许经由本文件访问模块能力，禁止深层导入内部实现。
 */
export * from './config/sceneMetrics'
export * from './config/labelPolicy'
export * from './config/cameraConfig'
export * from './config/qualityProfile'
export * from './config/mapLoadConfig'
export * from './config/visualTheme'
export * from './domain/errors'
export * from './domain/limits'
export * from './domain/factoryMap'
export * from './domain/coordinates'
export * from './domain/bounds'
export * from './domain/invariants'
export * from './domain/decodeMapEnvelope'
export * from './application/factorySceneModel'
export * from './application/factoryMapPageState'
export * from './application/loadFactoryMap'
export * from './application/ports/MapRepository'
export * from './application/ports/FactoryScenePreparer'
