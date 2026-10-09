import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  base: './',
  build: {
    outDir: '../build/web', emptyOutDir: true, target: 'safari16', modulePreload: false,
    rollupOptions: { output: { format: 'iife' } },
  },
});
