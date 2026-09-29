import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'node22',
    ssr: 'desktop/backend-entry.mjs',
    outDir: 'dist-backend',
    emptyOutDir: true,
    rollupOptions: {
      external: [...builtinModules, ...builtinModules.map((name) => `node:${name}`), 'typescript'],
      output: { format: 'es', entryFileNames: 'backend-entry.mjs' },
    },
  },
  ssr: { noExternal: true },
});
