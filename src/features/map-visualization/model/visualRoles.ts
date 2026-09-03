/**
 * 节点展示语义角色派生（视觉对齐改造 P0-5.4）。
 *
 * 职责：在不修改调度数据的前提下，由节点业务类别与道路邻居度数派生监控
 *       场景专用的 NodeVisualRole。生产环境最好由独立视觉配置显式提供
 *       角色；本模块的「类别 + 度数」启发式只是缺少配置时的降级方案。
 * 边界：纯函数，无 Three.js、无 React；输入只依赖已校验的类别与邻居数，
 *       不感知地图几何与渲染层。
 * 关键不变量：
 * 1. 业务类别优先：charge/park 恒为对应业务角色；度数只影响 work 与
 *    unknown 类别的细分（业务节点即使位于交叉路口也保持业务语义）；
 * 2. work 类别按道路形态细分：当前真实地图 3,045 个 work 点构成库位巷道
 *    网格（度数分布：1/2/3/4/5/6+ = 1/1499/1017/186/28/314）——只有主干
 *    走廊交汇（邻居 ≥5，342 个）承担「精选工位」的视觉权重
 *    （work-station，作业区可见）；其余（巷道中部与普通 T 岔）语义等同
 *    库位取放点，归入 storage-slot（仅车辆近景显示，作业区由仓储聚合轮
 *    廓接管）；
 * 3. unknown 类别按道路形态二分：邻居 ≥3 为 junction（交叉节点），≤2 为
 *    route-control（纯导航控制点）。
 */
import type { NodeCategory, NodeVisualRole } from './types'

/** work 节点被视为精选工位的最低道路邻居数（主干走廊交汇） */
export const WORK_STATION_MIN_NEIGHBORS = 5

/**
 * 由节点类别与道路邻居度数派生展示角色。
 * @param category 校验后的归一类别
 * @param neighborCount 不同邻居节点数（逻辑边去重后的道路度数代理）
 */
export function deriveNodeVisualRole(
  category: NodeCategory,
  neighborCount: number,
): NodeVisualRole {
  switch (category) {
    case 'work':
      return neighborCount >= WORK_STATION_MIN_NEIGHBORS ? 'work-station' : 'storage-slot'
    case 'warehouse':
      return 'storage-slot'
    case 'charge':
      return 'charge'
    case 'park':
      return 'park'
    case 'unknown':
      return neighborCount >= 3 ? 'junction' : 'route-control'
  }
}
