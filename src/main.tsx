import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RegistryContext } from '@effect/atom-react'
import { registry } from './state'
import { App } from './App'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RegistryContext.Provider value={registry}>
      <App />
    </RegistryContext.Provider>
  </StrictMode>,
)
