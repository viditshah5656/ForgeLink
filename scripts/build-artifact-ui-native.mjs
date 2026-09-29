import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checkOnly = process.argv.includes('--check');
const bundles = [
  ['artifact-ui', 'desktop/artifact-ui-client.js', 'desktop/artifact-ui-client.bundle.js', 100_000],
  ['code-review-ui', 'desktop/code-review-ui-client.js', 'desktop/code-review-ui-client.bundle.js', 4_000],
];
const output = [];
for (const [name, source, target, minimumBytes] of bundles) {
  const outfile = path.join(root, target);
  const sourceFile = path.join(root, source);
  const sourceContents = fs.readFileSync(sourceFile);
  if (sourceContents.length === 0) throw new Error(source + ' is empty. Restore the source before building; the last built bundle was left intact.');
  const sourceHash = crypto.createHash('sha256').update(sourceContents).digest('hex');
  const result = await build({
    absWorkingDir: root,
    entryPoints: ['./' + source],
    outfile: target,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    write: false,
    banner: { js: '/* FORGELINK_SOURCE_SHA256:' + sourceHash + ' */' },
  });
  const generated = result.outputFiles?.[0]?.contents;
  if (!generated || generated.length < minimumBytes) throw new Error(name + ' bundle was not generated correctly.');
  if (checkOnly) {
    const existing = fs.existsSync(outfile) ? fs.readFileSync(outfile) : null;
    if (!existing || !existing.equals(generated)) throw new Error(target + ' is stale. Run npm run build:artifact-ui.');
  } else {
    fs.writeFileSync(outfile, generated);
  }
  output.push({ name, sourceHash, target, bytes: generated.length });
}
console.log(JSON.stringify({ ok: true, checked: checkOnly, bundles: output }, null, 2));
