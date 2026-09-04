/**
 * 厂房外壳随地图和上下文资源代重建，与地坪使用同一布局。
 * 相机约束先于本层运行，剖切读取本帧最终观察方向，避免旋转时出现一帧遮挡。
 */
import { useEffect, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import type { FactoryLayout } from '../model/factoryLayout'
import { createFactoryShell } from '../scene/factoryShell'

export function FactoryLayer({ layout }: { readonly layout: FactoryLayout }) {
  const shell = useMemo(() => createFactoryShell(layout), [layout])
  useEffect(() => () => shell.dispose(), [shell])
  useFrame(({ camera }) => shell.updateCutaway(camera))
  return <primitive key={`factory-${shell.id}`} object={shell.group} dispose={null} />
}
