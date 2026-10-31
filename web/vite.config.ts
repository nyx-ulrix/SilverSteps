import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react(), {
    // Dev only: /report and /report/ serve the companion page, as app.py does in production.
    name: 'report-route',
    configureServer(server) {
      server.middlewares.use((req: { url?: string }, _res: unknown, next: () => void) => {
        if (req.url && /^\/report\/?(\?|$)/.test(req.url)) req.url = '/report.html' + req.url.replace(/^\/report\/?/, '')
        next()
      })
    },
  }],
  worker: { format: 'es' },
  // Two pages: the dashboard (index.html) and the residents' companion site (report.html, served at /report).
  build: { rollupOptions: { input: { main: 'index.html', report: 'report.html' } } },
  server: { proxy: { '/api': 'http://localhost:8000' } },
})
