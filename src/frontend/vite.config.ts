import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    // 兼容 PyQt5 QtWebEngine 常见的 Chromium 内核，避免过新的语法导致白屏。
    target: 'chrome80',
  },
});