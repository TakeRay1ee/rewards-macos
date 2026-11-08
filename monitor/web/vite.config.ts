import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 开发时把 /api 代理到本地监控服务；生产构建产物由 monitor/server 直接托管
export default defineConfig({
    plugins: [react()],
    server: {
        host: '127.0.0.1',
        port: 5173,
        proxy: {
            '/api': {
                target: 'http://127.0.0.1:3000',
                changeOrigin: false
            }
        }
    },
    build: {
        outDir: 'dist',
        emptyOutDir: true
    }
})
