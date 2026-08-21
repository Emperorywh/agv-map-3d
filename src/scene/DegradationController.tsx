import { useEffect, useRef } from 'react'

import {
  DEGRADE_FPS_SUSTAINED_WINDOWS,
  DEGRADE_FPS_THRESHOLD,
  DEGRADE_FPS_WARMUP_WINDOWS,
  DEGRADE_SCALE_MAX_AGVS,
  DEGRADE_SCALE_MAX_EDGES,
  DEGRADE_SCALE_MAX_NODES,
} from '../config/constants'
import {
  DEGRADE_LEVEL_MEASURE_NAMES,
  DEGRADE_LEVEL_NONE,
  DEGRADE_MAX_LEVEL,
  createFpsDegradeController,
  resolveScaleDegradeLevel,
} from '../rendering/scene/degradation'
import type {
  DegradeScaleLimits,
  FpsDegradeConfig,
  FpsDegradeController,
} from '../rendering/scene/degradation'
import { useAppStore } from '../state/appStore'

/**
 * 性能降级控制器（SPEC §9）：规模超限或实测帧率不足时按序启用降级措施
 * （关阴影 → 标签阈值收紧 → 隐藏普通导航点），等级写入 store.degradeLevel，
 * 由 SceneLighting（castShadow）/ MapLayer 与 AgvLayer 标签层（分级阈值）/
 * MapLayer 节点层（node 类整类隐藏阈值）订阅读取。
 *
 * - 规模触发：地图加载完成 / AGV 台数确定（首个 0.5s 快照）时重估，
 *   任一维度超上限（DEGRADE_SCALE_MAX_*）即至少 1 级；
 * - 帧率触发：消费 store.fps（FrameStats 的 0.5s 窗口均值，≤2Hz 低频通道，
 *   不订阅每帧瞬时值，SPEC §3 / §9），热身窗口后持续不足才按序升一级；
 * - 等级只升不降（防阈值附近来回抖动）；场景规模变化时重建状态机整体重估；
 * - 当前数据规模（1767 节点 / 3043 有向边 / 20 台）按设计不触发（SPEC §9 / §14），
 *   验证降级可用性可临时下调 config 阈值常量；每次启用新等级均 console 警告留痕。
 */

/** 规模上限：取自 config/constants.ts（SPEC §9 可调常量） */
const SCALE_LIMITS: DegradeScaleLimits = {
  maxNodes: DEGRADE_SCALE_MAX_NODES,
  maxEdges: DEGRADE_SCALE_MAX_EDGES,
  maxAgvs: DEGRADE_SCALE_MAX_AGVS,
}

/** 帧率触发配置：取自 config/constants.ts（SPEC §9 可调常量） */
const FPS_CONFIG: FpsDegradeConfig = {
  fpsThreshold: DEGRADE_FPS_THRESHOLD,
  warmupWindows: DEGRADE_FPS_WARMUP_WINDOWS,
  sustainedWindows: DEGRADE_FPS_SUSTAINED_WINDOWS,
  maxLevel: DEGRADE_MAX_LEVEL,
}

export function DegradationController() {
  const mapData = useAppStore((state) => state.mapData)
  // AGV 台数取 0.5s 低频快照长度（模拟器创建后恒定；selector 返回原始值，台数不变不重渲染）
  const agvCount = useAppStore((state) => state.agvSnapshot.length)
  const fps = useAppStore((state) => state.fps)
  const controllerRef = useRef<FpsDegradeController | null>(null)

  // 规模触发：地图 / AGV 台数变化 → 重建帧率状态机并重估等级（规模超限至少 1 级）
  useEffect(() => {
    if (mapData === null) {
      controllerRef.current = null
      useAppStore.getState().setDegradeLevel(DEGRADE_LEVEL_NONE)
      return
    }
    const counts = {
      nodes: mapData.nodes.length,
      edges: mapData.edges.length,
      agvs: agvCount,
    }
    const baseLevel = resolveScaleDegradeLevel(counts, SCALE_LIMITS)
    controllerRef.current = createFpsDegradeController(FPS_CONFIG, baseLevel)
    if (baseLevel > DEGRADE_LEVEL_NONE) {
      console.warn(
        `[degradation] 场景规模超限（节点 ${counts.nodes}/${SCALE_LIMITS.maxNodes}、` +
          `有向边 ${counts.edges}/${SCALE_LIMITS.maxEdges}、AGV ${counts.agvs}/${SCALE_LIMITS.maxAgvs}），` +
          `启用降级 ${baseLevel} 级：${DEGRADE_LEVEL_MEASURE_NAMES[baseLevel - 1]}`,
      )
    }
    useAppStore.getState().setDegradeLevel(baseLevel)
  }, [mapData, agvCount])

  // 帧率触发：fps 窗口均值（0.5s 低频）持续不足 → 按序升一级并告警留痕
  useEffect(() => {
    const controller = controllerRef.current
    if (fps === null || controller === null) {
      return
    }
    const before = controller.getLevel()
    const level = controller.pushWindowFps(fps)
    if (level !== before) {
      console.warn(
        `[degradation] 实测帧率持续低于 ${FPS_CONFIG.fpsThreshold}fps（当前窗口 ${fps}fps），` +
          `升级到 ${level} 级：${DEGRADE_LEVEL_MEASURE_NAMES[level - 1]}`,
      )
      useAppStore.getState().setDegradeLevel(level)
    }
  }, [fps])

  return null
}
