import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig(({ command }) => ({
  root: path.resolve('desktop/renderer'),
  base: './',
  plugins: [{
    name: 'local-files-renderer-csp',
    transformIndexHtml(html) {
      const contentSecurityPolicy = command === 'serve'
        ? "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://localhost:* http://localhost:* http://127.0.0.1:24025; object-src 'none'; base-uri 'none'; form-action 'none'"
        : "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' http://127.0.0.1:24025 http://localhost:24025; object-src 'none'; base-uri 'none'; form-action 'none'";
      return html.replace('LOCAL_FILES_CSP', contentSecurityPolicy);
    },
  }],
  build: {
    emptyOutDir: true,
  },
}));
