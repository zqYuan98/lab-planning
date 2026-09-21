import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(process.env.APP_BUILD_VERSION || `0.1.0-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}`) },
  server: { port: 5173, strictPort: true, proxy: { '/api': process.env.DEV_API_ORIGIN || 'http://127.0.0.1:4310' } },
})
