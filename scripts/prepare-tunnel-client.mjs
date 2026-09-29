import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const repository = 'https://api.github.com/repos/openai/tunnel-client/releases/latest';

function cliOption(name) {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const targetPlatform = cliOption('--platform') || process.env.FORGELINK_TARGET_PLATFORM || process.platform;
const targetArch = cliOption('--arch') || process.env.FORGELINK_TARGET_ARCH || process.arch;
const platformName = targetPlatform === 'win32' ? 'windows' : targetPlatform === 'darwin' ? 'darwin' : targetPlatform === 'linux' ? 'linux' : null;
const architecture = targetArch === 'arm64' ? 'arm64' : targetArch === 'x64' ? 'amd64' : null;
if (!platformName || !architecture) throw new Error(`Unsupported packaging target: ${targetPlatform}-${targetArch}`);

const executableName = targetPlatform === 'win32' ? 'tunnel-client.exe' : 'tunnel-client';
const destinationDir = path.resolve('vendor', 'tunnel-client', `${targetPlatform}-${targetArch}`);
const destination = path.join(destinationDir, executableName);
if (fs.existsSync(destination) && !process.argv.includes('--force')) {
  console.log(`Tunnel client is ready: ${destination}`);
  process.exit(0);
}

const headers = { 'User-Agent': 'local-files-desktop-builder', Accept: 'application/vnd.github+json' };
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

async function download(url, accept = 'application/octet-stream') {
  const response = await fetch(url, { headers: { ...headers, Accept: accept }, redirect: 'follow' });
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${new URL(url).pathname}`);
  return Buffer.from(await response.arrayBuffer());
}

async function run(file, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: 'inherit', windowsHide: true, shell: false });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${file} exited with code ${code}`)));
  });
}

async function findExecutable(folder) {
  for (const entry of await fsp.readdir(folder, { withFileTypes: true })) {
    const full = path.join(folder, entry.name);
    if (entry.isFile() && entry.name === executableName) return full;
    if (entry.isDirectory()) {
      const found = await findExecutable(full);
      if (found) return found;
    }
  }
  return null;
}

const releaseResponse = await fetch(repository, { headers });
if (!releaseResponse.ok) throw new Error(`Could not read the official tunnel-client release (${releaseResponse.status}).`);
const release = await releaseResponse.json();
const assetName = `tunnel-client-${release.tag_name}-${platformName}-${architecture}.zip`;
const asset = release.assets.find((candidate) => candidate.name === assetName);
const checksums = release.assets.find((candidate) => candidate.name === 'SHA256SUMS.txt');
if (!asset || !checksums) throw new Error(`Official release ${release.tag_name} does not include ${assetName}.`);

console.log(`Downloading official OpenAI ${assetName}…`);
const [archive, sums] = await Promise.all([
  download(asset.browser_download_url),
  download(checksums.browser_download_url, 'text/plain'),
]);
const expected = sums.toString('utf8').split(/\r?\n/).find((line) => line.trim().endsWith(assetName))?.trim().split(/\s+/)[0]?.toLowerCase();
const actual = crypto.createHash('sha256').update(archive).digest('hex');
if (!expected || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual))) throw new Error('Tunnel client checksum verification failed.');

const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'local-files-tunnel-'));
const zipFile = path.join(temporary, assetName);
const extractDir = path.join(temporary, 'extract');
try {
  await fsp.writeFile(zipFile, archive);
  await fsp.mkdir(extractDir);
  if (process.platform === 'win32') {
    await run('tar.exe', ['-xf', zipFile, '-C', extractDir]);
  } else if (process.platform === 'darwin') {
    await run('/usr/bin/ditto', ['-x', '-k', zipFile, extractDir]);
  } else {
    await run('unzip', ['-q', zipFile, '-d', extractDir]);
  }
  const executable = await findExecutable(extractDir);
  if (!executable) throw new Error(`The archive did not contain ${executableName}.`);
  await fsp.mkdir(destinationDir, { recursive: true });
  await fsp.copyFile(executable, destination);
  if (targetPlatform !== 'win32') await fsp.chmod(destination, 0o755);
  console.log(`Checksum verified; prepared ${destination}`);
} finally {
  await fsp.rm(temporary, { recursive: true, force: true });
}
