/**
 * 验收 harness 入口（SPEC §10.2/§15.2/§15.3，测试专用）。
 * 与生产 main.tsx 相同地以 StrictMode 挂载完整页面，但在渲染前安装测试桥。
 * 仅由 tests/harness/vite.config.ts 构建到 dist-harness/，不进入生产包。
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import '../../src/index.css'
import { HarnessPage } from './HarnessPage'
import { installTestBridge } from './installTestBridge'

installTestBridge()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HarnessPage />
  </StrictMode>,
)
