import assert from "node:assert/strict";
import testFn from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeAndValidatePdf, sanitizePdfFilename, saveArtifactPdf } from "./artifact-download.mjs";

const pdfBytes = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
const pdfBlob = pdfBytes.toString("base64");

testFn("artifact PDF saver validates content and writes collision-safe verified files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forgelink-pdf-"));
  try {
    const first = await saveArtifactPdf({ filename: "../../Audit Report.pdf", blob: pdfBlob, directory });
    const second = await saveArtifactPdf({ filename: "../../Audit Report.pdf", blob: pdfBlob, directory });
    assert.equal(first.filename, "Audit Report.pdf");
    assert.equal(second.filename, "Audit Report (2).pdf");
    assert.deepEqual(await readFile(first.path), pdfBytes);
    assert.equal(first.byteLength, pdfBytes.length);
    assert.match(first.sha256, /^[a-f0-9]{64}$/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

testFn("artifact PDF saver rejects malformed or non-PDF payloads", () => {
  assert.throws(() => decodeAndValidatePdf(Buffer.from("this is definitely not a pdf document").toString("base64")), /PDF signature/);
  assert.throws(() => decodeAndValidatePdf("not-base64"), /valid base64/);
  assert.equal(sanitizePdfFilename("..\\..\\unsafe:name"), "unsafename.pdf");
});
