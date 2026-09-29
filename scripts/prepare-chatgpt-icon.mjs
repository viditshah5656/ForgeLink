import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'logo.png');
const target = path.join(root, 'chatgpt-logo.png');

export async function prepareChatGptIcon() {
  const metadata = await sharp(source).metadata();
  if (metadata.format !== 'png' || !metadata.width || !metadata.height) {
    throw new Error('The canonical ForgeLink logo must be a readable PNG.');
  }

  const icon = await sharp(source)
    .resize(128, 128, { fit: 'contain' })
    .png({ compressionLevel: 9, palette: true, quality: 90 })
    .toBuffer();
  await fs.writeFile(target, icon);
  return { target, bytes: icon.length, width: 128, height: 128 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await prepareChatGptIcon();
  console.log(JSON.stringify(result, null, 2));
}
