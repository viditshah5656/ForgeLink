import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const branding = JSON.parse(await fs.readFile(path.join(root, 'branding.json'), 'utf8'));

const sourcePath = path.join(root, branding.logoSource);
const normalizedLogo = await sharp(sourcePath)
  .resize(1024, 1024, { fit: 'contain' })
  .png()
  .toBuffer();

// Normalize the canonical source itself so every consumer that declares image/png
// receives real PNG bytes rather than relying on extension sniffing.
await fs.writeFile(sourcePath, normalizedLogo);

const packagePath = path.join(root, 'package.json');
const pkg = JSON.parse(await fs.readFile(packagePath, 'utf8'));
pkg.name = branding.executableName.toLowerCase();
pkg.productName = branding.productName;
pkg.description = branding.description;
pkg.author = branding.developer;
pkg.version = branding.version;
await fs.writeFile(packagePath, JSON.stringify(pkg, null, 2) + '\n');

const destinations = [
  path.join(root, 'web', 'assets', branding.logoAsset),
  path.join(root, 'setup-web', branding.logoAsset),
  path.join(root, 'desktop', 'renderer', 'public', 'logo.png'),
];
for (const destination of destinations) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, normalizedLogo);
}

console.log(JSON.stringify({
  product: branding.productName,
  developer: branding.developer,
  logo: sourcePath,
  pngBytes: normalizedLogo.length,
  destinations,
}, null, 2));
