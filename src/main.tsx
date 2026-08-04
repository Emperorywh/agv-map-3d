import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { FactoryMapPage } from './features/factory-map'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <FactoryMapPage />
  </StrictMode>,
)
