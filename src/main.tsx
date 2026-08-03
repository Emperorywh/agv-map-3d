import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
// 把 mapBuild Worker 入口保留在构建图中，使 pnpm build 产出 module worker chunk
//（SPEC §3.1）；TASK-010 接入 FactoryMapPage 后由页面组合根接管 Worker 组装
void import('./features/factory-map')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
