import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { RootErrorBoundary } from './components/RootErrorBoundary'
import { initWatch } from './lib/watch'

// Module scope, not an effect: subscribes the stored watch selections (the
// active address and the overlay's shown wallets) exactly once — immune to
// StrictMode's double-fired effects.
initWatch()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </StrictMode>,
)
