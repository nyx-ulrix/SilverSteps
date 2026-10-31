import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/public-sans'
import '../styles.css'
import './report.css'
import Report from './Report.tsx'

createRoot(document.getElementById('root')!).render(<StrictMode><Report /></StrictMode>)
