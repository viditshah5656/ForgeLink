import assert from "node:assert/strict";
import testFn from "node:test";
import { generateArtifactReportPdf } from "./artifact-pdf-report.mjs";

testFn("server-side artifact report compositor produces a submission-grade multipage PDF", async () => {
  const artifact = {
    id: "artifact_test",
    revisions: 4,
    updatedAt: new Date().toISOString(),
    document: {
      type: "research-report",
      title: "MeeraAI — Deep Architecture, Security & Engineering Audit",
      subtitle: "Professional technical report",
      summary: "A representative executive overview for a formal engineering report.",
      metadata: { project: "MeeraAI", purpose: "Architecture and security audit", preparedBy: "Engineering Team" },
      assets: [],
      content: [
        "# MeeraAI — Deep Architecture, Security & Engineering Audit",
        "",
        "Opening technical context.",
        "",
        "## Architecture",
        "",
        "Key points:",
        "- Local-first backend",
        "- Electron desktop",
        "- Real-time voice runtime",
        "",
        "```architecture",
        "[Electron Host]",
        "-> React desktop",
        "-> Native IPC",
        "[Python Core]",
        "-> Chat orchestration",
        "-> RAG and agents",
        "[Voice Runtime]",
        "-> ASR",
        "-> TTS",
        "```",
        "",
        "## Verification",
        "",
        "```chart",
        JSON.stringify({type:"bar",title:"Verification profile",labels:["Python","Voice"],series:[{name:"Tests",values:[28,36]},{name:"Errors",values:[2,15]}]}),
        "```",
        "",
        "| Area | Status |",
        "| --- | --- |",
        "| Desktop | Healthy |",
        "| Backend | Needs test hardening |",
        "",
        "## Recommendations",
        "",
        "1. Consolidate trust boundaries.",
        "2. Stabilize API contracts.",
        "3. Improve reproducible verification."
      ].join("\n")
    }
  };

  const result = await generateArtifactReportPdf({ artifact });
  assert.ok(Buffer.isBuffer(result.bytes));
  assert.equal(result.bytes.subarray(0,5).toString(), "%PDF-");
  assert.ok(result.bytes.subarray(Math.max(0,result.bytes.length-4096)).toString("latin1").includes("%%EOF"));
  assert.ok(result.pageCount >= 3, "cover + contents + body should produce at least three pages");
  assert.ok(result.tocEntries >= 3);
  assert.ok(result.bytes.length > 8_000);
});
