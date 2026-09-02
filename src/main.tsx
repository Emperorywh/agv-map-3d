import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@/app/styles/global.css'
import App from '@/app/App'

// 浏览器唯一入口。
// 职责：把 <App /> 挂载到 #root，并始终包裹 StrictMode。
// 关键不变量：
// 1. StrictMode 不可移除——所有生命周期副作用必须在 setup→cleanup→setup 下保持对称；
// 2. 启动编排（SPEC §10.3 阶段与并行初始化）唯一归 App 的启动 effect 所有：
//    App 挂载不等待配置，配置读取期间页面即呈现唯一清屏 Canvas；配置失败
//    时仅由诊断通道记录结构化错误，绝不渲染任何错误 DOM。本入口不发起任
//    何加载（TASK-017 起 App 是唯一的启动编排者，避免重复拉取配置与地图）；
// 3. 不在此处引入业务逻辑、数据源或 3D 资源，组合只发生在 app 内部。
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
