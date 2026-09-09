/**
 * 厂房外壳随地图和上下文资源代重建，与地坪使用同一布局。
 * 玻璃合批在绘制时按实际相机排序，完整框架不再通过整墙剖切隐藏。
 */
import { useEffect, useMemo } from 'react'
import { Group } from 'three'
import type { FactoryLayout } from '../model/factoryLayout'
import { createFactoryShell } from '../scene/factoryShell'

export function FactoryLayer({ layout }: { readonly layout: FactoryLayout }) {
  const group = useMemo(() => new Group(), [])
  /**
   * 严格模式会先清理再设置副作用，建筑几何必须随每次设置重新创建。
   * 只复用无 GPU 资源的挂载组，避免幂等句柄被重复挂载后无法再次释放。
   */
  useEffect(() => {
    const shell = createFactoryShell(layout)
    group.add(shell.group)
    return () => {
      group.remove(shell.group)
      shell.dispose()
    }
  }, [layout, group])
  return <primitive object={group} dispose={null} />
}
