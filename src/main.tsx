import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@/app/styles/global.css'
import App from '@/app/App'

// 浏览器唯一入口。
// 职责：把 <App /> 挂载到 #root，并始终包裹 StrictMode。
// 关键不变量：
// 1. StrictMode 不可移除——所有生命周期副作用必须在 setup→cleanup→setup 下保持对称；
// 2. 不在此处引入任何业务逻辑、数据源或 3D 资源，组合只发生在 app 内部。
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
