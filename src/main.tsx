import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { sceneColors } from './config/theme'

// React 挂载前 / Canvas 之外的页面底色与画布背景同源（色彩唯一收口 config/theme.ts）
document.body.style.background = sceneColors.background

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
