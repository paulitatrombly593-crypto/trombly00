import { defineConfig } from 'vite';

export default defineConfig({
  base: './', // Electron 로컬 파일(file://) 로딩 시 경로 깨짐 방지 필수 옵션
  build: {
    outDir: 'dist',
    emptyOutDir: true
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true
  }
});