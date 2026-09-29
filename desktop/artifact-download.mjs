import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MAX_PDF_BYTES = 25 * 1024 * 1024;

export function sanitizePdfFilename(value) {
  let filename = path.basename(String(value || "ForgeLink-Artifact.pdf"))
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .trim()
    .replace(/[. ]+$/g, "");
  if (!filename.toLowerCase().endsWith(".pdf")) filename += ".pdf";
  const stem = filename.slice(0, -4).trim().slice(0, 120) || "ForgeLink-Artifact";
  return stem + ".pdf";
}

export function decodeAndValidatePdf(blob) {
  const encoded = String(blob || "").replace(/\s+/g, "");
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error("PDF payload is not valid base64");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length < 12 || bytes.length > MAX_PDF_BYTES) throw new Error("PDF payload size is outside the allowed range");
  if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("PDF payload is missing the PDF signature");
  const tail = bytes.subarray(Math.max(0, bytes.length - 4096)).toString("latin1");
  if (!tail.includes("%%EOF")) throw new Error("PDF payload is incomplete");
  return bytes;
}

export function defaultDownloadsDirectory() {
  const home = os.homedir();
  const configured = String(process.env.FORGELINK_DOWNLOAD_DIR || process.env.XDG_DOWNLOAD_DIR || "").trim();
  if (configured) {
    const expanded = configured
      .replace(/^\$HOME(?=$|[\\/])/, home)
      .replace(/^~(?=$|[\\/])/, home);
    return path.resolve(expanded);
  }
  return path.join(home, "Downloads");
}

function collisionName(filename, index) {
  if (!index) return filename;
  const ext = path.extname(filename);
  return path.basename(filename, ext) + " (" + (index + 1) + ")" + ext;
}

export async function saveArtifactPdf({ filename, blob, directory = defaultDownloadsDirectory() }) {
  const bytes = decodeAndValidatePdf(blob);
  const safeFilename = sanitizePdfFilename(filename);
  const targetDirectory = path.resolve(directory);
  await fsp.mkdir(targetDirectory, { recursive: true });

  for (let index = 0; index < 1000; index++) {
    const candidateName = collisionName(safeFilename, index);
    const candidate = path.join(targetDirectory, candidateName);
    let handle;
    try {
      handle = await fsp.open(candidate, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = null;
      const stat = await fsp.stat(candidate);
      if (!stat.isFile() || stat.size !== bytes.length) throw new Error("Saved PDF verification failed");
      return {
        filename: candidateName,
        path: candidate,
        byteLength: stat.size,
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      };
    } catch (error) {
      if (handle) {
        try { await handle.close(); } catch {}
      }
      if (error?.code === "EEXIST") continue;
      try { await fsp.rm(candidate, { force: true }); } catch {}
      throw error;
    }
  }
  throw new Error("Could not allocate a unique filename in Downloads");
}
