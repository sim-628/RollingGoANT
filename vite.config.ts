import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: Number(process.env.ANT_WEB_PORT || 5173),
    proxy: { '/api': { target: `http://127.0.0.1:${process.env.ANT_API_PORT || 8787}`, changeOrigin: false } }
  }
});
