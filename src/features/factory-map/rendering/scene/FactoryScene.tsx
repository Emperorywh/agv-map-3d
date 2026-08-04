/**
 * FactoryScene：三维场景组合根（SPEC §5 场景架构树、§10.3、§11）。
 *
 * ready / empty 状态的完整三维场景（empty 使用模型的 60×40m 空厂房 bounds，
 * 「暂无地图数据」DOM overlay 由 FactoryMapPage 叠加，不属于三维场景）：
 *
 *   FactoryScene
 *   ├── FactoryCanvas   — WebGL renderer、质量策略、灯光、天空/雾宿主（TASK-009）
 *   │   ├── CameraRig   — 初始 fit + OrbitControls（TASK-009）
 *   │   └── FactorySceneContent
 *   │       └── FactoryLayer — 厂房环境（TASK-008；地坪/围墙/桁架/外景）
 *   ├── MapLayer        — TASK-011 插入（与 FactoryLayer 平级）
 *   └── LabelLayer      — TASK-012 插入
 *
 * 资源所有权（§10.3）：FactorySceneContent 是 FactorySceneResources 的唯一
 * React owner——挂载时 setup（bounds + renderer 最大各向异性），卸载时 dispose；
 * setup/dispose 幂等，React StrictMode 重复挂载不产生重复 WebGL 资源。
 * 进入新一轮加载时 FactoryMapPage 立即切换到 loading 并卸载本组件（§11：
 * 不保留旧画面），因此 bounds 在组件存活期内不变。
 */

import { useThree } from '@react-three/fiber'
import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'

import type { FactoryBoundsDto, FactorySceneModel } from '../../application/factorySceneModel'
import type { WebGLUnavailableError } from '../../domain/errors'
import { createFactorySceneResources } from '../resources/FactorySceneResources'
import type { FactorySceneSnapshot } from '../resources/FactorySceneResources'
import { CameraRig } from './CameraRig'
import { FactoryCanvas } from './FactoryCanvas'
import { FactoryLayer } from './FactoryLayer'

export interface FactorySceneProps {
  /** 完整场景模型（§5.1 唯一场景契约）；本任务消费 bounds，MapLayer/LabelLayer 插入后消费批次与标签 */
  readonly model: FactorySceneModel
  /** §11：WebGL2/context 初始化失败或 context lost 上抛页面（不自动恢复） */
  readonly onWebGLUnavailable: (error: WebGLUnavailableError) => void
}

interface FactorySceneContentProps {
  readonly bounds: FactoryBoundsDto
}

/**
 * 厂房环境资源 owner：setup 返回快照后经 FactoryLayer 挂载；卸载 dispose。
 * 首帧渲染前快照为 null（不挂载任何环境 mesh），effect 建立快照后重渲染。
 */
function FactorySceneContent({ bounds }: FactorySceneContentProps): ReactElement | null {
  const gl = useThree((state) => state.gl)
  const [snapshot, setSnapshot] = useState<FactorySceneSnapshot | null>(null)

  useEffect(() => {
    // §10.3：本组件是唯一 owner；setup/dispose 幂等——StrictMode 重复挂载
    // 先 dispose 再重建，任一时刻仅一份资源
    const resources = createFactorySceneResources()
    // §6.2：anisotropy = min(8, renderer.capabilities.getMaxAnisotropy())（上限在 resources 内夹取）
    setSnapshot(resources.setup(bounds, gl.capabilities.getMaxAnisotropy()))
    return () => {
      resources.dispose()
      setSnapshot(null)
    }
  }, [bounds, gl])

  return snapshot === null ? null : <FactoryLayer resources={snapshot} />
}

export function FactoryScene({ model, onWebGLUnavailable }: FactorySceneProps): ReactElement {
  const { bounds } = model
  return (
    <FactoryCanvas bounds={bounds} onWebGLUnavailable={onWebGLUnavailable}>
      <CameraRig bounds={bounds} />
      <FactorySceneContent bounds={bounds} />
    </FactoryCanvas>
  )
}
