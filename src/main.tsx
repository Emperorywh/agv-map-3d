import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import '@/app/styles/global.css'
import App from '@/app/App'

/**
 * 样板入口仅在开发环境显式启用，设施预览不加载真实地图和业务数据源。
 * 生产构建会删除预览模块，默认入口继续执行原有启动和恢复流程。
 */
/**
 * 空间样板和设备样板共用显式开发参数，生产入口不打包验收控件。
 * 空间样板复用正式墙体、地坪与光照，以浏览器效果作为材质验收依据。
 */
const previewKind = import.meta.env.DEV ? new URLSearchParams(window.location.search).get('assets') : null
/**
 * 四元素场景可在生产与开发访问，仍只挂载一个画布和一套渲染流程。
 * 原监控入口保留；小样参数明确区分演示数据与真实地图。
 */
const navigationKind = new URLSearchParams(window.location.search).get('scene')
const Preview = navigationKind === 'sample' || navigationKind === 'navigation'
  ? lazy(() => import('@/app/preview/NavigationPreview'))
  : previewKind === 'industrial'
  ? lazy(() => import('@/app/preview/IndustrialPreview'))
  : previewKind === 'factory' ? lazy(() => import('@/app/preview/FactoryPreview')) : null

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
    {Preview === null ? <App /> : <Suspense fallback={null}><Preview /></Suspense>}
  </StrictMode>,
)
