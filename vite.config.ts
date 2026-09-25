import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
const buildVersion = process.env.APP_BUILD_VERSION || `0.1.0-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}`
if (!/^[A-Za-z0-9_.-]{1,80}$/.test(buildVersion)) throw new Error('APP_BUILD_VERSION 必须是 1–80 位字母、数字、点、下划线或连字符')
export default defineConfig({
  plugins: [react(), {
    name: 'workspace-build-info',
    generateBundle() { this.emitFile({ type: 'asset', fileName: 'build-info.json', source: `${JSON.stringify({ version: buildVersion })}\n` }) },
  }],
  build: { manifest: true, assetsInlineLimit: 0 },
  define: { __APP_VERSION__: JSON.stringify(buildVersion) },
  server: { port: 5173, strictPort: true, proxy: { '/api': process.env.DEV_API_ORIGIN || 'http://127.0.0.1:4310' } },
})
