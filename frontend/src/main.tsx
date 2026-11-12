import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
// Initialise i18next before any component imports translated helpers.
import './i18n'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
