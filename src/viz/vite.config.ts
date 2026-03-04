import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: 'src/viz',
  build: { outDir: '../../dist/viz', emptyOutDir: true },
  server: {
    port: 4201,
    proxy: { '/api': 'http://localhost:4200' },
  },
});
