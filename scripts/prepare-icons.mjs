import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';

const source = path.resolve('assets', 'app-icon.svg');
const output = path.resolve('assets', 'generated');
await fsp.mkdir(output, { recursive: true });

async function png(size, filename) {
  const buffer = await sharp(source).resize(size, size).png().toBuffer();
  if (filename) await fsp.writeFile(filename, buffer);
  return buffer;
}

async function run(file, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${file} exited with code ${code}`)));
  });
}

await png(1024, path.join(output, 'icon.png'));
if (process.platform === 'win32') {
  const buffers = await Promise.all([16, 24, 32, 48, 64, 128, 256].map((size) => png(size)));
  await fsp.writeFile(path.join(output, 'icon.ico'), await pngToIco(buffers));
  console.log('Prepared Windows application icons.');
} else if (process.platform === 'darwin') {
  const iconset = path.join(output, 'AppIcon.iconset');
  await fsp.rm(iconset, { recursive: true, force: true });
  await fsp.mkdir(iconset);
  for (const [name, size] of Object.entries({
    'icon_16x16.png': 16, 'icon_16x16@2x.png': 32,
    'icon_32x32.png': 32, 'icon_32x32@2x.png': 64,
    'icon_128x128.png': 128, 'icon_128x128@2x.png': 256,
    'icon_256x256.png': 256, 'icon_256x256@2x.png': 512,
    'icon_512x512.png': 512, 'icon_512x512@2x.png': 1024,
  })) await png(size, path.join(iconset, name));
  await run('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', path.join(output, 'icon.icns')]);
  await fsp.rm(iconset, { recursive: true, force: true });
  console.log('Prepared macOS application icons.');
}
