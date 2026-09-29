import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'node_modules', 'typescript');
const destination = path.join(root, 'dist-backend', 'node_modules', 'typescript');
await fs.access(path.join(source, 'lib', 'lib.es5.d.ts'));
await fs.mkdir(path.dirname(destination), { recursive: true });
await fs.cp(source, destination, { recursive: true });
console.log('Prepared TypeScript runtime for the bundled backend');
