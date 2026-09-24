import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
  root: path.resolve('desktop/renderer'),
  base: './',
  build: {
    emptyOutDir: true,
  },
});
