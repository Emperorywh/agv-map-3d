/**
 * 厂房外壳随地图和上下文资源代重建，与地坪使用同一布局。
 * 相机约束先于本层运行，剖切读取本帧最终观察方向，避免旋转时出现一帧遮挡。
 */
import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Group } from 'three'
import type { FactoryLayout } from '../model/factoryLayout'
import { createFactoryShell, type FactoryShellHandle } from '../scene/factoryShell'

export function FactoryLayer({ layout }: { readonly layout: FactoryLayout }) {
  const group = useMemo(() => new Group(), [])
  const shellRef = useRef<FactoryShellHandle | null>(null)
  /**
   * 严格模式会先清理再设置副作用，建筑几何必须随每次设置重新创建。
   * 只复用无 GPU 资源的挂载组，避免幂等句柄被重复挂载后无法再次释放。
   */
  useEffect(() => {
    const shell = createFactoryShell(layout)
    shellRef.current = shell
    group.add(shell.group)
    return () => {
      shellRef.current = null
      group.remove(shell.group)
      shell.dispose()
    }
  }, [layout, group])
  useFrame(({ camera }) => shellRef.current?.updateCutaway(camera))
  return <primitive object={group} dispose={null} />
}
