import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@/app/styles/global.css'
import App from '@/app/App'
import { bootstrapApplication } from '@/app/bootstrap/bootstrapApplication'

// 浏览器唯一入口。
// 职责：把 <App /> 挂载到 #root，并始终包裹 StrictMode；同时启动启动编排
//       （TASK-002：读取并校验运行时 config.json，阶段耗时写入诊断通道）。
// 关键不变量：
// 1. StrictMode 不可移除——所有生命周期副作用必须在 setup→cleanup→setup 下保持对称；
// 2. App 挂载不等待配置：配置读取期间页面即呈现唯一清屏 Canvas，配置失败时
//    仅由诊断通道记录结构化错误（bootstrap 内部已上报），本 catch 只吞掉拒绝
//    以避免 unhandledrejection，绝不渲染任何错误 DOM；
// 3. 不在此处引入业务逻辑、数据源或 3D 资源，组合只发生在 app 内部。
const bootstrapController = new AbortController()
void bootstrapApplication({ signal: bootstrapController.signal }).catch(() => {
  // 结构化诊断已在 bootstrapApplication 内部上报；此处静默，保持清屏 Canvas。
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
