import { App } from "@modelcontextprotocol/ext-apps";
import { jsPDF } from "jspdf";

const root = document.getElementById("root");
let currentArtifact = null;
let currentArtifactIdentity = "";
let artifactExpanded = false;
let displayMode = "inline";
let expandedBeforeFullscreen = false;
let pendingFullscreenPreviousExpanded = null;
let feedbackTimer = null;
let appConnected = false;
let sizeReportFrame = 0;
let linkedWorkflow = null;
let linkedWorkflowArtifactIdentity = "";
let workflowLookupActive = false;
let workflowActionActive = false;
let workflowActionError = "";
let currentAccessRequest = null;
let accessActionActive = false;
let accessActionError = "";
let accessRiskConfirmed = false;
let currentMaintenanceRequest = null;
let maintenanceActionActive = false;
let maintenanceActionError = "";
let currentPermissionRequest = null;
let permissionChallenge = "";
let permissionActionActive = false;
let permissionActionError = "";
let permissionRiskConfirmed = false;

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);

const clean = (value) => value === undefined || value === null ? "" : String(value).trim();
const humanize = (value) => clean(value).replace(/[-_]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());

const formatDate = (value) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};

function icon(name) {
  const paths = {
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="m18 6-12 12M6 6l12 12"/>',
    shield: '<path d="M12 3 5 6v5c0 4.8 2.8 8.1 7 10 4.2-1.9 7-5.2 7-10V6l-7-3Z"/><path d="m9 12 2 2 4-4"/>',
    document: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5M9 12h6M9 16h6"/>',
    evidence: '<circle cx="11" cy="11" r="6"/><path d="m16 16 4 4M8 11l2 2 4-4"/>',
    arrow: '<path d="M5 12h14M14 7l5 5-5 5"/>',
    alert: '<path d="M12 3 2.8 20h18.4L12 3Z"/><path d="M12 9v4M12 17h.01"/>',
    terminal: '<path d="m5 7 4 4-4 4M11 17h7"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 10v6M12 7h.01"/>',
    sparkle: '<path d="m12 3 1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3Z"/><path d="m18 15 .8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8L18 15Z"/>',
    external: '<path d="M14 4h6v6"/><path d="m20 4-9 9"/><path d="M20 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h6"/>',
    copy: '<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    undo: '<path d="M9 7 5 11l4 4"/><path d="M5 11h8a6 6 0 0 1 6 6"/>',
    review: '<path d="M4 5h16v14H4z"/><path d="M8 9h8M8 13h5"/>',
    file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5"/>',
  };
  return '<span class="icon" aria-hidden="true"><svg viewBox="0 0 24 24">' + (paths[name] || paths.info) + "</svg></span>";
}

function statusTone(status) {
  if (status === "verified") return "tone-success";
  if (status === "failed" || status === "not-verified") return "tone-danger";
  if (status === "recommended") return "tone-info";
  if (status === "inferred") return "tone-warning";
  return "tone-neutral";
}

function safeImageSource(value) {
  const source = clean(value);
  if (/^data:image\/(?:png|jpeg|jpg|webp|gif);base64,/i.test(source)) return source;
  if (/^https:\/\//i.test(source)) return source;
  return "";
}

function visualNodes(block) {
  const content = block?.content;
  if (content && typeof content === "object" && Array.isArray(content.nodes)) {
    return content.nodes.slice(0, 24).map((node, index) => clean(node?.label || node?.title || node?.name || node?.id || "Step " + (index + 1))).filter(Boolean);
  }
  const source = clean(block?.text || (typeof content === "string" ? content : ""));
  const labels = [];
  for (const match of source.matchAll(/\[([^\]]+)\]/g)) {
    const label = clean(match[1]);
    if (label && !labels.includes(label)) labels.push(label);
    if (labels.length >= 24) break;
  }
  return labels;
}

function renderEngineeringVisual(block) {
  const language = clean(block?.language).toLowerCase();
  if (language === "image") {
    const content = block?.content && typeof block.content === "object" ? block.content : {};
    const src = safeImageSource(content.src || block.text);
    if (!src) return '<div class="content-block visual-unavailable">' + icon("alert") + '<span>Image asset is unavailable or uses an unsafe source.</span></div>';
    const alt = clean(content.alt || content.title || "Engineering visual");
    const caption = clean(content.caption || content.title);
    return '<figure class="content-block artifact-image-card"><img src="' + esc(src) + '" alt="' + esc(alt) + '" loading="lazy">' +
      (caption ? '<figcaption>' + esc(caption) + '</figcaption>' : "") + '</figure>';
  }

  const nodes = visualNodes(block);
  if (nodes.length >= 2) {
    return '<div class="content-block engineering-diagram"><div class="diagram-header">' + icon("sparkle") +
      '<span>' + esc(humanize(language || "diagram")) + '</span></div><div class="diagram-flow">' +
      nodes.map((node, index) => '<div class="diagram-step"><div class="diagram-node">' + esc(node) + '</div>' +
        (index < nodes.length - 1 ? '<div class="diagram-arrow" aria-hidden="true">' + icon("arrow") + '</div>' : "") +
      '</div>').join("") + '</div></div>';
  }
  return "";
}

function renderBlock(block) {
  if (!block) return "";

  if (block.type === "paragraph") return '<p class="content-block paragraph-block">' + esc(block.text) + "</p>";
  if (block.type === "heading") return '<div class="content-block subsection-heading">' + esc(block.text || block.title) + "</div>";
  if (block.type === "bullets") return '<ul class="content-block premium-list">' + (block.items || []).map((item) => '<li><span class="list-dot"></span><span>' + esc(item) + "</span></li>").join("") + "</ul>";
  if (block.type === "quote") return '<blockquote class="content-block quote-block">' + esc(block.text) + "</blockquote>";
  if (block.type === "divider") return '<div class="section-divider"></div>';
  if (block.type === "evidence") return '<div class="content-block inline-evidence">' + icon("evidence") + "<span>" + esc(block.text || block.content || "") + "</span></div>";

  if (block.type === "callout") {
    return '<div class="content-block callout-card"><div class="callout-icon">' + icon("info") + '</div><div class="callout-body"><div class="callout-title">' + esc(block.title || "Note") + '</div><div class="callout-copy">' + esc(block.text) + "</div></div></div>";
  }

  if (block.type === "code") {
    const language = clean(block.language).toLowerCase();
    if (["mermaid", "flowchart", "diagram", "architecture", "image"].includes(language)) {
      const visual = renderEngineeringVisual(block);
      if (visual) return visual;
    }
    return '<div class="content-block code-shell"><div class="code-header"><div class="code-language">' + icon("terminal") + "<span>" + esc(humanize(block.language || "code")) + '</span></div></div><pre class="code-block"><code>' + esc(block.text || block.content || "") + "</code></pre></div>";
  }

  if (block.type === "table") {
    const columns = block.columns || [];
    const rows = block.rows || [];
    const head = columns.length ? "<thead><tr>" + columns.map((column) => "<th>" + esc(column) + "</th>").join("") + "</tr></thead>" : "";
    const body = "<tbody>" + rows.map((row) => "<tr>" + (row || []).map((cell) => "<td>" + esc(cell) + "</td>").join("") + "</tr>").join("") + "</tbody>";
    return '<div class="content-block table-card"><div class="table-scroll"><table>' + head + body + "</table></div></div>";
  }

  return "";
}

function renderMetadata(metadata, item) {
  const entries = Object.entries(metadata || {}).filter(([key, value]) => clean(value) && !['phase', 'status', 'lifecyclePhase', 'implementationState'].includes(key)).slice(0, 10);
  if (!entries.length) return "";
  return '<div class="metadata-grid">' +
    entries.map(([key, value]) => '<div class="metadata-chip"><span class="metadata-key">' + esc(humanize(key)) + '</span><span class="metadata-value">' + esc(value) + "</span></div>").join("") +
    "</div>";
}

function renderSections(sections) {
  return (sections || []).map((section, index) =>
    '<section class="artifact-section content-section"><div class="section-heading"><div class="section-number">' +
    String(index + 1).padStart(2, "0") +
    '</div><div class="section-title-group"><div class="section-kicker">SECTION</div><h2>' +
    esc(section.title) +
    '</h2></div></div><div class="section-body">' +
    (section.blocks || []).map(renderBlock).join("") +
    "</div></section>"
  ).join("");
}

function renderVerification(entries) {
  if (!entries?.length) return "";

  const passed = entries.filter((entry) => entry.passed).length;
  const failed = entries.length - passed;
  const percentage = Math.round((passed / entries.length) * 100);

  return '<section class="artifact-section"><div class="section-heading section-heading-spread"><div><div class="section-kicker">QUALITY GATE</div><h2>Verification</h2></div><div class="verification-score ' +
    (failed ? "score-failed" : "score-passed") +
    '"><span class="score-value">' + percentage + '%</span><span class="score-label">' + passed + "/" + entries.length + ' passed</span></div></div><div class="verification-grid">' +
    entries.map((entry, index) => {
      const success = Boolean(entry.passed);
      return '<article class="verification-card ' + (success ? "verification-pass" : "verification-fail") +
        '"><div class="verification-icon">' + icon(success ? "check" : "x") +
        '</div><div class="verification-content"><div class="verification-topline"><span class="verification-index">' +
        String(index + 1).padStart(2, "0") +
        '</span><span class="status-badge ' + (success ? "badge-success" : "badge-danger") + '">' +
        (success ? "Passed" : "Failed") +
        "</span></div><h3>" + esc(entry.check) + "</h3>" +
        (entry.evidence ? '<p class="verification-evidence">' + esc(entry.evidence) + "</p>" : "") +
        (entry.command ? '<div class="command-pill">' + icon("terminal") + "<code>" + esc(entry.command) + "</code></div>" : "") +
        "</div></article>";
    }).join("") +
    "</div></section>";
}

function renderEvidence(entries) {
  if (!entries?.length) return "";

  return '<section class="artifact-section"><div class="section-heading section-heading-spread"><div><div class="section-kicker">TRACEABILITY</div><h2>Evidence</h2></div><div class="section-count">' +
    entries.length + " " + (entries.length === 1 ? "item" : "items") +
    '</div></div><div class="evidence-grid">' +
    entries.map((entry, index) => {
      const reference = [entry.path, entry.lines, entry.source, entry.reference].filter(Boolean).join(" · ");
      return '<article class="evidence-card"><div class="evidence-number">' + String(index + 1).padStart(2, "0") +
        '</div><div class="evidence-body"><div class="evidence-topline"><span class="status-badge ' + statusTone(entry.certainty) + '">' +
        esc(humanize(entry.certainty || "observed")) +
        "</span></div><h3>" + esc(entry.claim) + "</h3>" +
        (reference ? '<div class="evidence-reference">' + icon("evidence") + "<span>" + esc(reference) + "</span></div>" : "") +
        "</div></article>";
    }).join("") +
    "</div></section>";
}

function renderWalkthrough(text) {
  if (!clean(text)) return "";
  return '<section class="artifact-section"><div class="section-heading"><div><div class="section-kicker">IMPLEMENTATION STORY</div><h2>Walkthrough</h2></div></div><div class="walkthrough-card"><div class="walkthrough-icon">' +
    icon("arrow") + "</div><p>" + esc(text) + "</p></div></section>";
}

function renderLimitations(items) {
  if (!items?.length) return "";
  return '<section class="artifact-section"><div class="section-heading"><div><div class="section-kicker">BOUNDARIES</div><h2>Limitations</h2></div></div><div class="limitations-card"><div class="limitations-header">' +
    icon("alert") + "<span>Important context</span></div><ul>" +
    items.map((item) => '<li><span class="limitation-dot"></span><span>' + esc(item) + "</span></li>").join("") +
    "</ul></div></section>";
}

function markdownCell(value) {
  return clean(value).replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

function blockToMarkdown(block) {
  if (!block) return "";
  if (block.type === "paragraph") return clean(block.text);
  if (block.type === "heading") {
    const level = Number.isInteger(block.level) && block.level >= 1 && block.level <= 6 ? block.level : 3;
    return "#".repeat(level) + " " + clean(block.text || block.title);
  }
  if (block.type === "bullets") return (block.items || []).map((item) => "- " + clean(item)).join("\n");
  if (block.type === "quote") return clean(block.text).split(/\r?\n/).map((line) => "> " + line).join("\n");
  if (block.type === "divider") return "---";
  if (block.type === "evidence") return "> Evidence: " + clean(block.text || block.content || "");
  if (block.type === "callout") {
    const title = clean(block.title || "NOTE").toUpperCase();
    return "> [!" + title + "]\n> " + clean(block.text);
  }
  if (block.type === "code") return "```" + clean(block.language || "") + "\n" + String(block.text || block.content || "") + "\n```";
  if (block.type === "table") {
    const columns = block.columns || [];
    const rows = block.rows || [];
    if (!columns.length && !rows.length) return "";
    const width = Math.max(columns.length, ...rows.map((row) => (row || []).length), 1);
    const header = Array.from({ length: width }, (_, index) => markdownCell(columns[index] || "Column " + (index + 1)));
    const separator = Array.from({ length: width }, () => "---");
    const body = rows.map((row) => Array.from({ length: width }, (_, index) => markdownCell(row?.[index] ?? "")));
    return [header, separator, ...body].map((row) => "| " + row.join(" | ") + " |").join("\n");
  }
  return "";
}

function artifactToMarkdown(item, documentValue) {
  if (documentValue?.content && typeof documentValue.content === "string" && documentValue.content.trim()) {
    return documentValue.content.trim() + "\n";
  }
  if (documentValue?.markdown && typeof documentValue.markdown === "string" && documentValue.markdown.trim()) {
    return documentValue.markdown.trim() + "\n";
  }

  const existingTitles = new Set((documentValue?.sections || []).map((s) => clean(s.title).toLowerCase()));
  const lines = [
    "# " + clean(documentValue?.title || "ForgeLink Artifact"),
  ];
  if (documentValue?.subtitle) lines.push(clean(documentValue.subtitle));

  if (documentValue?.summary) lines.push("", "## Executive Summary", clean(documentValue.summary));

  for (const section of documentValue?.sections || []) {
    lines.push("", "## " + clean(section.title));
    for (const block of section.blocks || []) {
      const rendered = blockToMarkdown(block);
      if (rendered) lines.push("", rendered);
    }
  }

  if ((documentValue?.verification || []).length && !existingTitles.has("verification")) {
    lines.push("", "## Verification");
    for (const check of documentValue.verification) {
      lines.push("- **" + (check.passed ? "PASS" : "FAIL") + "** — " + clean(check.check));
      if (check.evidence) lines.push("  - Evidence: " + clean(check.evidence));
      if (check.command) lines.push("  - Command: `" + clean(check.command).replace(/`/g, "\\`") + "`");
    }
  }

  if ((documentValue?.evidence || []).length && !existingTitles.has("evidence")) {
    lines.push("", "## Evidence");
    for (const evidence of documentValue.evidence) {
      lines.push("- **" + humanize(evidence.certainty || "observed") + "** — " + clean(evidence.claim));
      const reference = [evidence.path, evidence.lines, evidence.source, evidence.reference].filter(Boolean).join(" · ");
      if (reference) lines.push("  - " + reference);
    }
  }

  if (documentValue?.walkthrough && !existingTitles.has("walkthrough")) {
    lines.push("", "## Walkthrough", clean(documentValue.walkthrough));
  }
  if ((documentValue?.limitations || []).length && !existingTitles.has("limitations")) {
    lines.push("", "## Limitations");
    for (const limitation of documentValue.limitations) lines.push("- " + clean(limitation));
  }

  return lines.filter((line, index, all) => line !== "" || all[index - 1] !== "").join("\n").trim() + "\n";
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (error) {
      console.warn("ForgeLink clipboard API unavailable; using fallback", error);
    }
  }

  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  area.style.pointerEvents = "none";
  document.body.appendChild(area);
  area.select();
  const copied = document.execCommand("copy");
  area.remove();
  if (!copied) throw new Error("Clipboard copy was rejected");
}

function flashButtonLabel(button, label, duration = 1400) {
  if (!button) return;
  const labelNode = button.querySelector(".button-label");
  if (!labelNode) return;
  const original = button.dataset.defaultLabel || labelNode.textContent || "";
  button.dataset.defaultLabel = original;
  labelNode.textContent = label;
  if (feedbackTimer) clearTimeout(feedbackTimer);
  feedbackTimer = setTimeout(() => {
    if (button.isConnected) labelNode.textContent = original;
  }, duration);
}

function pdfSafe(value) {
  return String(value ?? "")
    .replace(/→/g, "->")
    .replace(/[–—]/g, "-")
    .replace(/•/g, "-")
    .replace(/[^ -~\n]/g, "");
}

function pdfFilename(title) {
  const base = pdfSafe(title || "ForgeLink Artifact")
    .replace(/[^A-Za-z0-9._ -]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80) || "ForgeLink-Artifact";
  return base + ".pdf";
}

function pdfBytes(doc) {
  const buffer = doc.output("arraybuffer");
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 5) {
    throw new Error("ForgeLink generated an empty PDF.");
  }
  const bytes = new Uint8Array(buffer);
  const signature = String.fromCharCode(...bytes.subarray(0, 5));
  if (signature !== "%PDF-") throw new Error("ForgeLink generated invalid PDF bytes.");
  return bytes;
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function browserDownloadPdf(bytes, filename) {
  if (typeof Blob !== "function" || typeof URL?.createObjectURL !== "function") {
    throw new Error("This host does not support MCP file downloads or browser Blob downloads.");
  }

  const blob = new Blob([bytes], { type: "application/pdf" });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);

  try {
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
  }

  return { status: "downloaded", method: "browser", filename };
}

async function exportArtifactPdf(item, documentValue) {
  try {
    const doc = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
    const margin = 16;
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const usableWidth = pageWidth - margin * 2;
    let y = 18;

    const ensure = (height = 8) => {
      if (y + height > pageHeight - 18) {
        doc.addPage();
        y = 18;
      }
    };

    const write = (text, { size = 10, style = "normal", color = [45, 49, 57], gap = 4, indent = 0 } = {}) => {
      const value = pdfSafe(text);
      if (!value) return;
      doc.setFont("helvetica", style);
      doc.setFontSize(size);
      doc.setTextColor(...color);
      const lines = doc.splitTextToSize(value, usableWidth - indent);
      const lineHeight = Math.max(4.2, size * 0.42);
      ensure(lines.length * lineHeight + gap);
      doc.text(lines, margin + indent, y);
      y += lines.length * lineHeight + gap;
    };

    const rule = () => {
      ensure(5);
      doc.setDrawColor(218, 222, 229);
      doc.line(margin, y, pageWidth - margin, y);
      y += 6;
    };

    doc.setFillColor(24, 27, 34);
    doc.rect(0, 0, pageWidth, 8, "F");
    y = 18;
    write("FORGELINK · " + humanize(documentValue.type || "artifact"), { size: 8, style: "bold", color: [103, 92, 252], gap: 3 });
    write(documentValue.title, { size: 20, style: "bold", color: [18, 21, 27], gap: 3 });
    if (documentValue.subtitle) write(documentValue.subtitle, { size: 10, color: [92, 99, 111], gap: 6 });

    const metadata = Object.entries(documentValue.metadata || {}).filter(([, value]) => clean(value));
    if (metadata.length) {
      for (const [key, value] of metadata) write(humanize(key) + ": " + value, { size: 8.5, color: [96, 103, 115], gap: 1.7 });
      y += 3;
    }
    rule();

    if (documentValue.summary) {
      write("Executive Summary", { size: 13, style: "bold", color: [18, 21, 27], gap: 3 });
      write(documentValue.summary, { size: 10, color: [62, 68, 78], gap: 7 });
    }

    for (let sectionIndex = 0; sectionIndex < (documentValue.sections || []).length; sectionIndex++) {
      const section = documentValue.sections[sectionIndex];
      ensure(16);
      write(String(sectionIndex + 1).padStart(2, "0") + "  " + section.title, { size: 13, style: "bold", color: [18, 21, 27], gap: 4 });
      for (const block of section.blocks || []) {
        if (block.type === "paragraph") write(block.text, { size: 10, color: [62, 68, 78], gap: 4 });
        else if (block.type === "heading") write(block.text || block.title, { size: 11, style: "bold", gap: 3 });
        else if (block.type === "bullets") for (const value of block.items || []) write("- " + value, { size: 9.5, color: [62, 68, 78], gap: 2, indent: 2 });
        else if (block.type === "callout") {
          if (block.title) write(block.title, { size: 9.5, style: "bold", color: [55, 105, 214], gap: 2 });
          write(block.text, { size: 9.5, color: [62, 68, 78], gap: 4, indent: 2 });
        } else if (block.type === "quote") write('"' + block.text + '"', { size: 9.5, style: "italic", color: [92, 99, 111], gap: 4, indent: 3 });
        else if (block.type === "code") {
          write(humanize(block.language || "code"), { size: 8.5, style: "bold", color: [92, 99, 111], gap: 2 });
          doc.setFont("courier", "normal");
          write(block.text || block.content || "", { size: 8, color: [42, 47, 55], gap: 5, indent: 2 });
          doc.setFont("helvetica", "normal");
        } else if (block.type === "table") {
          const columns = block.columns || [];
          if (columns.length) write(columns.join(" | "), { size: 8.5, style: "bold", gap: 2 });
          for (const row of block.rows || []) write((row || []).join(" | "), { size: 8.2, color: [62, 68, 78], gap: 1.5 });
          y += 2;
        } else if (block.type === "evidence") write(block.text || block.content || "", { size: 9, color: [17, 135, 93], gap: 3 });
        else if (block.type === "divider") rule();
      }
      y += 2;
    }

    const hasPdfSection = (name) => (documentValue.sections || []).some((s) => clean(s.title).toLowerCase() === name.toLowerCase());

    if ((documentValue.verification || []).length && !hasPdfSection("verification")) {
      rule();
      write("Verification", { size: 13, style: "bold", gap: 4 });
      for (const check of documentValue.verification) {
        write((check.passed ? "PASS  " : "FAIL  ") + check.check, { size: 9.5, style: "bold", color: check.passed ? [17, 135, 93] : [195, 58, 74], gap: 2 });
        if (check.evidence) write(check.evidence, { size: 8.8, color: [92, 99, 111], gap: 3, indent: 3 });
      }
    }

    if ((documentValue.evidence || []).length && !hasPdfSection("evidence")) {
      rule();
      write("Evidence", { size: 13, style: "bold", gap: 4 });
      for (const evidence of documentValue.evidence) {
        write(humanize(evidence.certainty || "observed") + " · " + evidence.claim, { size: 9.3, style: "bold", gap: 2 });
        const reference = [evidence.path, evidence.lines, evidence.source, evidence.reference].filter(Boolean).join(" · ");
        if (reference) write(reference, { size: 8.5, color: [92, 99, 111], gap: 3, indent: 3 });
      }
    }

    if (documentValue.walkthrough && !hasPdfSection("walkthrough")) {
      rule();
      write("Implementation Walkthrough", { size: 13, style: "bold", gap: 4 });
      write(documentValue.walkthrough, { size: 9.7, color: [62, 68, 78], gap: 5 });
    }

    if ((documentValue.limitations || []).length && !hasPdfSection("limitations")) {
      rule();
      write("Limitations", { size: 13, style: "bold", gap: 4 });
      for (const limitation of documentValue.limitations) write("- " + limitation, { size: 9.2, color: [92, 99, 111], gap: 2, indent: 2 });
    }

    const pageCount = doc.internal.getNumberOfPages();
    for (let page = 1; page <= pageCount; page++) {
      doc.setPage(page);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(7.5);
      doc.setTextColor(128, 134, 145);
      doc.text("ForgeLink Artifact Engine · Schema v" + (documentValue.schemaVersion || 1) + " · Revision " + (item?.revisions || 1), margin, pageHeight - 8);
      doc.text(page + " / " + pageCount, pageWidth - margin, pageHeight - 8, { align: "right" });
    }

    const filename = pdfFilename(documentValue.title);
    const bytes = pdfBytes(doc);
    const hostSupportsDownload = Boolean(app.getHostCapabilities?.()?.downloadFile);

    if (hostSupportsDownload) {
      const result = await app.downloadFile({
        contents: [{
          type: "resource",
          resource: {
            uri: "file:///" + filename,
            mimeType: "application/pdf",
            blob: bytesToBase64(bytes),
          },
        }],
      });

      if (result?.isError === true) {
        return { status: "cancelled", method: "host", filename };
      }
      return { status: "downloaded", method: "host", filename };
    }

    return browserDownloadPdf(bytes, filename);
  } catch (error) {
    console.error("ForgeLink PDF export failed", error);
    throw error;
  }
}

async function downloadCurrentArtifact(button) {
  if (!currentArtifact || !button || button.disabled) return;
  const artifact = currentArtifact;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  flashButtonLabel(button, "Preparing…", 60_000);

  try {
    const result = await exportArtifactPdf(artifact.item, artifact.documentValue);
    if (result?.status === "cancelled") {
      flashButtonLabel(button, "Cancelled", 1800);
    } else if (result?.method === "browser") {
      flashButtonLabel(button, "Download started", 1800);
    } else {
      flashButtonLabel(button, "Downloaded", 1800);
    }
  } catch (error) {
    console.error("ForgeLink artifact download failed", error);
    flashButtonLabel(button, "Download failed", 2400);
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}

function previewText(documentValue) {
  const summary = clean(documentValue?.summary);
  if (summary) return summary;

  if (documentValue?.content && typeof documentValue.content === "string") {
    const lines = documentValue.content.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith('```') && !l.startsWith('|'));
    if (lines.length && lines[0]) return lines[0];
  }

  for (const section of documentValue?.sections || []) {
    for (const block of section?.blocks || []) {
      const candidate = clean(block?.text || block?.content);
      if (candidate) return candidate;
    }
  }

  return "Open the full artifact to review the complete document.";
}

function toolResultPayload(result) {
  if (result?.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  for (const part of result?.content || []) {
    if (part?.type !== "text" || typeof part.text !== "string") continue;
    try { return JSON.parse(part.text); } catch {}
  }
  return null;
}

function workflowStatusCopy(status) {
  const copy = {
    awaiting_user_review: ["Approval required", "Review the plan, then approve once to resume this exact workflow."],
    running: ["Approved · execution resumed", "ForgeLink is continuing the approved workflow from its persisted state."],
    ready_for_verification: ["Execution complete", "Implementation finished and the workflow is ready for verification."],
    review_required: ["Review required", "Worker execution reached another explicit review boundary."],
    completed: ["Completed", "This engineering workflow has completed."],
    cancelled: ["Declined", "This implementation workflow was declined and will not execute."],
    failed: ["Workflow failed", "ForgeLink stopped this workflow because execution failed."],
    recovery_error: ["Recovery blocked", "ForgeLink could not safely recover this persisted workflow."],
  };
  return copy[status] || [humanize(status || "workflow"), "ForgeLink has a persisted workflow linked to this implementation plan."];
}

function renderWorkflowApproval() {
  const slot = root.querySelector("#workflow-approval-slot");
  if (!slot) return;
  const documentValue = currentArtifact?.documentValue;
  if (!documentValue || clean(documentValue.type) !== "implementation-plan") {
    slot.innerHTML = "";
    return;
  }

  if (!appConnected || workflowLookupActive) {
    slot.innerHTML = '<section class="workflow-approval-card workflow-loading"><div class="workflow-approval-icon">' + icon("shield") +
      '</div><div class="workflow-approval-copy"><div class="workflow-approval-kicker">EXECUTION GATE</div><h3>Checking linked workflow…</h3><p>ForgeLink is resolving this plan against its persisted engineering workflow.</p></div></section>';
    return;
  }

  if (!linkedWorkflow) {
    slot.innerHTML = "";
    return;
  }

  const status = clean(linkedWorkflow.status);
  const [title, description] = workflowStatusCopy(status);
  const awaiting = status === "awaiting_user_review";
  const tone = awaiting ? "workflow-warning" : status === "cancelled" || status === "failed" || status === "recovery_error" ? "workflow-danger" : "workflow-success";
  const error = workflowActionError ? '<div class="workflow-action-error">' + esc(workflowActionError) + '</div>' : "";
  const actions = awaiting
    ? '<div class="workflow-approval-actions"><button class="workflow-button workflow-approve" id="workflow-approve" type="button"' + (workflowActionActive ? " disabled" : "") + '>' +
        icon("check") + '<span>' + (workflowActionActive ? "Applying…" : "Approve & continue") + '</span></button>' +
      '<button class="workflow-button workflow-decline" id="workflow-decline" type="button"' + (workflowActionActive ? " disabled" : "") + '>' +
        icon("x") + '<span>Decline</span></button></div>'
    : "";

  slot.innerHTML = '<section class="workflow-approval-card ' + tone + '"><div class="workflow-approval-icon">' + icon(awaiting ? "shield" : status === "cancelled" || status === "failed" || status === "recovery_error" ? "alert" : "check") +
    '</div><div class="workflow-approval-copy"><div class="workflow-approval-topline"><div><div class="workflow-approval-kicker">IMPLEMENTATION PLAN</div><h3>' + esc(title) +
    '</h3></div><span class="workflow-status-pill">' + esc(humanize(status)) + '</span></div><p>' + esc(description) +
    '</p><div class="workflow-approval-meta"><span>Workflow</span><code>' + esc(linkedWorkflow.id || "") + '</code></div>' + error + actions + '</div></section>';

  root.querySelector("#workflow-approve")?.addEventListener("click", () => void decideLinkedWorkflow("approve"));
  root.querySelector("#workflow-decline")?.addEventListener("click", () => void decideLinkedWorkflow("decline"));
}

async function refreshLinkedWorkflow({ force = false } = {}) {
  const artifactId = clean(currentArtifact?.item?.id);
  const documentValue = currentArtifact?.documentValue;
  if (!artifactId || clean(documentValue?.type) !== "implementation-plan" || !appConnected) return;
  if (!force && linkedWorkflowArtifactIdentity === artifactId && linkedWorkflow) {
    renderWorkflowApproval();
    return;
  }

  linkedWorkflowArtifactIdentity = artifactId;
  workflowLookupActive = true;
  workflowActionError = "";
  renderWorkflowApproval();
  try {
    if (!app.getHostCapabilities?.()?.serverTools) throw new Error("This ChatGPT host does not expose MCP server-tool calls to the artifact.");
    const result = await app.callServerTool({ name: "engineering_workflow_list", arguments: { limit: 200 } });
    if (result?.isError) throw new Error("ForgeLink could not inspect the linked engineering workflow.");
    const payload = toolResultPayload(result);
    linkedWorkflow = (payload?.workflows || []).find((workflow) => clean(workflow?.primaryArtifactId) === artifactId) || null;
  } catch (error) {
    linkedWorkflow = null;
    workflowActionError = clean(error?.message || error || "Workflow lookup failed.");
  } finally {
    workflowLookupActive = false;
    renderWorkflowApproval();
    queueHostSizeReport();
  }
}

async function decideLinkedWorkflow(decision) {
  if (workflowActionActive || !linkedWorkflow?.id) return;
  workflowActionActive = true;
  workflowActionError = "";
  renderWorkflowApproval();
  try {
    const approving = decision === "approve";
    const result = await app.callServerTool({
      name: approving ? "engineering_workflow_approve" : "engineering_workflow_cancel",
      arguments: approving
        ? {
            workflowId: linkedWorkflow.id,
            approvedBy: "forgelink-inline-owner",
            note: "Approved from the ForgeLink implementation-plan MCP App. Resume the persisted workflow immediately.",
          }
        : {
            workflowId: linkedWorkflow.id,
            message: "Declined from the ForgeLink implementation-plan MCP App.",
          },
    });
    if (result?.isError) throw new Error(approving ? "ForgeLink rejected the workflow approval." : "ForgeLink could not cancel the workflow.");

    await refreshLinkedWorkflow({ force: true });

    try {
      const message = approving
        ? "I approved the ForgeLink implementation plan in the inline approval card. Continue the same persisted workflow " + linkedWorkflow.id + " now. Do not ask me to type 'go for it' or repeat this approval; only ask again if a new protected capability or new filesystem scope requires separate permission."
        : "I declined the ForgeLink implementation plan in the inline approval card. Do not execute workflow " + linkedWorkflow.id + ".";
      const messageResult = await app.sendMessage({ role: "user", content: [{ type: "text", text: message }] });
      if (messageResult?.isError) throw new Error("Chat continuation was rejected by the host.");
    } catch (error) {
      workflowActionError = "The workflow decision was saved, but ChatGPT could not auto-submit the continuation message. " + clean(error?.message || "");
    }
  } catch (error) {
    workflowActionError = clean(error?.message || error || "Workflow action failed.");
  } finally {
    workflowActionActive = false;
    renderWorkflowApproval();
    queueHostSizeReport();
  }
}

function queueHostSizeReport() {
  if (!appConnected || displayMode === "fullscreen") return;

  if (sizeReportFrame) cancelAnimationFrame(sizeReportFrame);
  sizeReportFrame = requestAnimationFrame(() => {
    sizeReportFrame = requestAnimationFrame(() => {
      sizeReportFrame = 0;
      const container = root.querySelector(".artifact-app") || root;
      const height = Math.max(1, Math.ceil(container.getBoundingClientRect().height));
      void app.sendSizeChanged({ height }).catch((error) => {
        console.warn("ForgeLink could not report artifact height to the host", error);
      });
    });
  });
}

function setArtifactExpanded(expanded) {
  artifactExpanded = Boolean(expanded);
  const container = root.querySelector(".artifact-app");
  if (!container) return;

  container.classList.toggle("is-expanded", artifactExpanded);
  container.classList.toggle("is-collapsed", !artifactExpanded);
  container.dataset.expanded = String(artifactExpanded);

  const toggleButton = root.querySelector("#toggle-artifact");
  if (toggleButton) {
    toggleButton.setAttribute("aria-expanded", String(artifactExpanded));
    toggleButton.title = artifactExpanded ? "Collapse this artifact in chat" : "View the full artifact in chat";
    const label = toggleButton.querySelector(".toggle-label");
    if (label) label.textContent = artifactExpanded ? "Collapse artifact" : "View full artifact";
  }

  if (!artifactExpanded) {
    const expandedContent = root.querySelector(".artifact-expanded-content");
    if (expandedContent) expandedContent.scrollTop = 0;
  }

  queueHostSizeReport();
}

async function openArtifactAppView(button) {
  pendingFullscreenPreviousExpanded = artifactExpanded;
  setArtifactExpanded(true);

  try {
    const context = app.getHostContext?.();
    if (Array.isArray(context?.availableDisplayModes) && !context.availableDisplayModes.includes("fullscreen")) {
      pendingFullscreenPreviousExpanded = null;
      flashButtonLabel(button, "Expanded here");
      return;
    }

    const result = await app.requestDisplayMode({ mode: "fullscreen" });
    if (result?.mode === "fullscreen") {
      expandedBeforeFullscreen = pendingFullscreenPreviousExpanded ?? expandedBeforeFullscreen;
      pendingFullscreenPreviousExpanded = null;
      displayMode = "fullscreen";
      document.documentElement.dataset.displayMode = displayMode;
      setArtifactExpanded(true);
      flashButtonLabel(button, "Opened");
    } else {
      pendingFullscreenPreviousExpanded = null;
      flashButtonLabel(button, "Expanded here");
    }
  } catch (error) {
    pendingFullscreenPreviousExpanded = null;
    console.warn("ForgeLink focused app view unavailable; keeping artifact expanded inline", error);
    flashButtonLabel(button, "Expanded here");
  }
}

async function copyCurrentArtifact(button) {
  if (!currentArtifact) return;
  try {
    await copyText(artifactToMarkdown(currentArtifact.item, currentArtifact.documentValue));
    flashButtonLabel(button, "Copied");
  } catch (error) {
    console.error("ForgeLink artifact copy failed", error);
    flashButtonLabel(button, "Copy failed", 1800);
  }
}

function accessLevelLabel(access) {
  return access === "read_write" ? "Read + write" : "Read only";
}

function renderAccessRequest() {
  const request = currentAccessRequest;
  if (!request) return;
  const pending = clean(request.status || "pending") === "pending";
  const risky = Boolean(request.requiresExtraConfirmation || request.isDriveRoot);
  const approved = clean(request.status) === "approved";
  const denied = clean(request.status) === "denied";
  const actionLabel = accessActionActive
    ? "Applying…"
    : risky && !accessRiskConfirmed
      ? "Review risk"
      : "Allow once";
  const error = accessActionError ? '<div class="workflow-action-error">' + esc(accessActionError) + '</div>' : "";
  const warning = risky
    ? '<div class="access-risk-warning">' + icon("alert") +
        '<div><strong>High-risk scope</strong><span>This path is a drive root, user root, system location, or similarly sensitive scope. A second confirmation is required.</span></div></div>'
    : "";
  const result = approved
    ? '<div class="access-resolution access-resolution-success">' + icon("check") + '<span>Allowed once. The grant is consumed by the next authorized operation.</span></div>'
    : denied
      ? '<div class="access-resolution access-resolution-denied">' + icon("x") + '<span>Denied. No filesystem grant was created.</span></div>'
      : "";

  root.innerHTML = '<div class="artifact-app access-request-app is-collapsed"><div class="ambient ambient-one"></div><div class="ambient ambient-two"></div>' +
    '<header class="artifact-hero access-request-hero"><div class="hero-top"><div class="brand"><div class="artifact-logo" role="img" aria-label="ForgeLink"></div>' +
    '<div class="brand-copy"><span class="brand-name">ForgeLink</span><span class="brand-divider"></span><span class="document-kind">Security approval</span></div></div></div>' +
    '<div class="hero-content"><div class="hero-eyebrow">ONE-TIME FILESYSTEM ACCESS</div><h1>ForgeLink needs another directory</h1>' +
    '<p class="compact-summary">Review the exact scope below. Approval applies once to this request and does not become a permanent folder grant.</p></div></header>' +
    '<main class="access-request-body"><section class="access-request-card">' +
      '<div class="access-request-row"><span>Directory</span><code>' + esc(request.path || "") + '</code></div>' +
      '<div class="access-request-row"><span>Access</span><strong>' + esc(accessLevelLabel(request.access)) + '</strong></div>' +
      '<div class="access-request-row"><span>Scope</span><strong>One operation only</strong></div>' +
      '<div class="access-request-row access-request-reason"><span>Reason</span><p>' + esc(request.justification || "ForgeLink needs this directory to continue the current task.") + '</p></div>' +
      warning + error + result +
      (pending ? '<div class="workflow-approval-actions access-request-actions">' +
        '<button class="workflow-button workflow-approve" id="access-allow-once" type="button"' + (accessActionActive ? " disabled" : "") + '>' +
          icon(risky && !accessRiskConfirmed ? "shield" : "check") + '<span>' + esc(actionLabel) + '</span></button>' +
        '<button class="workflow-button workflow-decline" id="access-deny" type="button"' + (accessActionActive ? " disabled" : "") + '>' +
          icon("x") + '<span>Deny</span></button></div>' : "") +
    '</section></main></div>';

  root.querySelector("#access-allow-once")?.addEventListener("click", () => {
    if (risky && !accessRiskConfirmed) {
      accessRiskConfirmed = true;
      renderAccessRequest();
      return;
    }
    void decidePathAccess("allow_once");
  });
  root.querySelector("#access-deny")?.addEventListener("click", () => void decidePathAccess("deny"));
  queueHostSizeReport();
}

async function decidePathAccess(decision) {
  if (accessActionActive || !currentAccessRequest?.requestId) return;
  accessActionActive = true;
  accessActionError = "";
  renderAccessRequest();
  const requestId = currentAccessRequest.requestId;
  const requestedPath = currentAccessRequest.path || "";
  try {
    if (!app.getHostCapabilities?.()?.serverTools) throw new Error("This ChatGPT host does not expose MCP server-tool calls to the approval card.");
    const result = await app.callServerTool({
      name: "resolve_path_access_once",
      arguments: { requestId, decision },
    });
    if (result?.isError) throw new Error("ForgeLink rejected the access decision.");
    const payload = toolResultPayload(result);
    currentAccessRequest = {
      ...currentAccessRequest,
      ...(payload?.accessRequest || payload || {}),
      requestId,
    };
    if (!currentAccessRequest.status) currentAccessRequest.status = decision === "deny" ? "denied" : "approved";
    renderAccessRequest();

    let continuationTokenVisible = "";
    if (decision === "allow_once") {
      const capabilityToken = clean(payload?.capabilityToken);
      const intendedTool = clean(payload?.intendedTool || currentAccessRequest.intendedTool);
      if (!capabilityToken || !intendedTool) throw new Error("ForgeLink approved the request without returning a bound one-time capability.");

      const modelContext = [
        "FORGELINK ONE-TIME ACCESS CAPABILITY",
        "Use exactly once in this conversation.",
        "Call use_path_access_once with the capability token below, the bound tool name, and the original tool arguments.",
        "Capability token: " + capabilityToken,
        "Bound tool: " + intendedTool,
        "Approved directory: " + requestedPath,
        "Do not reuse this capability, do not transfer it to another scope, and do not request persistent access.",
      ].join("\n");

      try {
        const contextResult = await app.updateModelContext({ content: [{ type: "text", text: modelContext }] });
        if (contextResult?.isError) throw new Error("Host rejected the private model-context update.");
      } catch {
        continuationTokenVisible = " Capability token: " + capabilityToken + ". Bound tool: " + intendedTool + ".";
      }
    }

    const prompt = decision === "allow_once"
      ? "I approved one-time ForgeLink access to " + requestedPath + " for the current task. Continue the original operation now through use_path_access_once. The capability is single-use and scoped to this approval." + continuationTokenVisible
      : "I denied ForgeLink access to " + requestedPath + ". Do not access that directory; continue only with already-approved scopes or ask for a different exact scope if genuinely necessary.";
    const messageResult = await app.sendMessage({ role: "user", content: [{ type: "text", text: prompt }] });
    if (messageResult?.isError) throw new Error("Chat continuation was rejected by the host.");
  } catch (error) {
    accessActionError = clean(error?.message || error || "Access decision failed.");
  } finally {
    accessActionActive = false;
    renderAccessRequest();
  }
}

function renderMaintenanceRequest() {
  const request = currentMaintenanceRequest;
  if (!request) return;
  const status = clean(request.status || "pending");
  const pending = status === "pending";
  const approved = status === "approved" || status === "activating";
  const active = status === "active";
  const denied = status === "denied";
  const error = maintenanceActionError ? '<div class="workflow-action-error">' + esc(maintenanceActionError) + '</div>' : "";
  const stateCard = active
    ? '<div class="access-resolution access-resolution-success">' + icon("check") + '<span>Maintenance is active. ForgeLink will automatically return to protected mode when the 15-minute window expires.</span></div>'
    : approved
      ? '<div class="maintenance-activating">' + icon("shield") + '<div><strong>Owner approval saved</strong><span>Waiting for the local ForgeLink desktop enforcer to restart the backend with the expiring maintenance capability.</span></div></div>'
      : denied
        ? '<div class="access-resolution access-resolution-denied">' + icon("x") + '<span>Denied. Protected ForgeLink source remains remote read-only.</span></div>'
        : "";

  root.innerHTML = '<div class="artifact-app access-request-app maintenance-request-app is-collapsed"><div class="ambient ambient-one"></div><div class="ambient ambient-two"></div>' +
    '<header class="artifact-hero access-request-hero"><div class="hero-top"><div class="brand"><div class="artifact-logo" role="img" aria-label="ForgeLink"></div>' +
    '<div class="brand-copy"><span class="brand-name">ForgeLink</span><span class="brand-divider"></span><span class="document-kind">Protected maintenance approval</span></div></div></div>' +
    '<div class="hero-content"><div class="hero-eyebrow">SECURITY-SENSITIVE OWNER APPROVAL</div><h1>Allow protected-source maintenance?</h1>' +
    '<p class="compact-summary">ForgeLink needs a temporary maintenance window to modify its own protected runtime/security source. The model can request this window but cannot approve it.</p></div></header>' +
    '<main class="access-request-body"><section class="access-request-card maintenance-request-card">' +
      '<div class="access-request-row"><span>Capability</span><strong>Modify protected ForgeLink source</strong></div>' +
      '<div class="access-request-row"><span>Duration</span><strong>15 minutes · automatic expiry</strong></div>' +
      '<div class="access-request-row"><span>Restart</span><strong>Backend and tunnels restart to enter protected maintenance mode</strong></div>' +
      '<div class="access-request-row access-request-reason"><span>Reason</span><p>' + esc(request.justification || "A requested ForgeLink implementation requires a reviewed change to protected source.") + '</p></div>' +
      '<div class="access-risk-warning">' + icon("alert") + '<div><strong>High-impact maintenance capability</strong><span>During this window approved coding tools may modify ForgeLink security/runtime source. The window cannot be made permanent and automatically closes after 15 minutes.</span></div></div>' +
      error + stateCard +
      (pending ? '<div class="workflow-approval-actions access-request-actions">' +
        '<button class="workflow-button workflow-approve" id="maintenance-allow" type="button"' + (maintenanceActionActive ? " disabled" : "") + '>' +
          icon("shield") + '<span>' + (maintenanceActionActive ? "Applying…" : "Allow maintenance for 15 min") + '</span></button>' +
        '<button class="workflow-button workflow-decline" id="maintenance-deny" type="button"' + (maintenanceActionActive ? " disabled" : "") + '>' +
          icon("x") + '<span>Deny</span></button></div>' : "") +
    '</section></main></div>';

  root.querySelector("#maintenance-allow")?.addEventListener("click", () => void decideSecurityMaintenance("allow"));
  root.querySelector("#maintenance-deny")?.addEventListener("click", () => void decideSecurityMaintenance("deny"));
  queueHostSizeReport();
}

async function waitForSecurityMaintenanceActive(timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 900));
    try {
      const result = await app.callServerTool({ name: "security_maintenance_status", arguments: {} });
      if (result?.isError) continue;
      const payload = toolResultPayload(result);
      if (payload?.maintenance?.active === true || payload?.active === true) return payload?.maintenance || payload;
    } catch {}
  }
  throw new Error("ForgeLink did not return in protected maintenance mode within the expected restart window.");
}

async function decideSecurityMaintenance(decision) {
  if (maintenanceActionActive || !currentMaintenanceRequest?.requestId) return;
  maintenanceActionActive = true;
  maintenanceActionError = "";
  renderMaintenanceRequest();
  const requestId = currentMaintenanceRequest.requestId;
  try {
    if (!app.getHostCapabilities?.()?.serverTools) throw new Error("This ChatGPT host does not expose MCP server-tool calls to the approval card.");
    const result = await app.callServerTool({
      name: "resolve_security_maintenance",
      arguments: { requestId, decision },
    });
    if (result?.isError) throw new Error("ForgeLink rejected the maintenance decision.");

    const payload = toolResultPayload(result);
    currentMaintenanceRequest = {
      ...currentMaintenanceRequest,
      ...(payload?.maintenanceRequest || payload || {}),
      requestId,
    };
    if (!currentMaintenanceRequest.status) currentMaintenanceRequest.status = decision === "deny" ? "denied" : "approved";
    renderMaintenanceRequest();

    if (decision === "allow") {
      currentMaintenanceRequest.status = "activating";
      renderMaintenanceRequest();
      const continuationPromise = app.sendMessage({
        role: "user",
        content: [{
          type: "text",
          text: "I approved ForgeLink protected-source maintenance for 15 minutes in the inline security card. Resume the same protected implementation now. Verify the authoritative maintenance state before the protected write; if the desktop enforcer is still activating it, retry the status check without asking me to approve again.",
        }],
      });

      const activeState = await waitForSecurityMaintenanceActive();
      currentMaintenanceRequest = {
        ...currentMaintenanceRequest,
        status: "active",
        expiresAt: activeState?.expiresAt || currentMaintenanceRequest.expiresAt,
      };
      renderMaintenanceRequest();

      const messageResult = await continuationPromise;
      if (messageResult?.isError) throw new Error("Chat continuation was rejected by the host.");
    } else {
      const messageResult = await app.sendMessage({
        role: "user",
        content: [{
          type: "text",
          text: "I denied ForgeLink protected-source maintenance. Do not modify protected ForgeLink source.",
        }],
      });
      if (messageResult?.isError) throw new Error("Chat continuation was rejected by the host.");
    }
  } catch (error) {
    maintenanceActionError = clean(error?.message || error || "Maintenance decision failed.");
  } finally {
    maintenanceActionActive = false;
    renderMaintenanceRequest();
  }
}

function permissionTitle(request) {
  if (request.kind === 'folder') return 'Allow folder access?';
  if (request.kind === 'terminal') return 'Allow Terminal access?';
  if (request.kind === 'windows') return 'Allow Windows Control?';
  return 'Enable protected-source maintenance?';
}

function permissionLevel(request) {
  if (request.kind === 'folder') return request.level === 'read_write' ? 'Read and modify files' : 'Read files';
  if (request.kind === 'terminal') return request.level === 'full' ? 'Full Headless Terminal' : 'Guarded project tasks';
  if (request.kind === 'windows') return request.level === 'full' ? 'Full Windows Control' : 'Windows Read and screenshots';
  return 'Modify protected ForgeLink runtime/security source';
}

function renderPermissionRequest() {
  const request = currentPermissionRequest;
  if (!request) return;
  const expiresAt = Date.parse(request.expiresAt || '');
  const expired = request.status === 'expired' || (Number.isFinite(expiresAt) && expiresAt <= Date.now());
  const pending = request.status === 'pending' && !expired;
  const highRisk = request.risk !== 'normal';
  const lifetime = request.persistent ? 'Until revoked' : '15 minutes';
  const decisionStage = highRisk && !permissionRiskConfirmed ? '1 of 2 · Review impact' : highRisk ? '2 of 2 · Confirm access' : 'Ready for decision';
  const maintenanceGrantStatus = request.kind === 'maintenance' ? request.grant?.status : '';
  const approvedMessage = maintenanceGrantStatus === 'awaiting_desktop_enforcer' || maintenanceGrantStatus === 'activating'
    ? 'Approval recorded. Restarting ForgeLink securely…'
    : maintenanceGrantStatus === 'reconnecting'
      ? 'ForgeLink is restarting. Waiting for the protected backend to reconnect…'
      : maintenanceGrantStatus === 'active'
        ? 'ForgeLink reconnected with protected maintenance active. Resuming this chat now…'
        : maintenanceGrantStatus === 'resumed'
          ? 'ForgeLink reconnected. This chat resumed automatically.'
          : 'Approved. ForgeLink applied this exact permission.';
  const outcome = request.status === 'approved'
    ? '<div class="access-resolution access-resolution-success">' + icon('check') + '<span>' + approvedMessage + '</span></div>'
    : request.status === 'denied'
      ? '<div class="access-resolution access-resolution-denied">' + icon('x') + '<span>Denied. No new permission was granted.</span></div>'
      : expired
        ? '<div class="access-resolution access-resolution-denied">' + icon('x') + '<span>This approval request expired. Ask ChatGPT to request it again.</span></div>' : '';
  const impactText = request.kind === 'folder'
    ? 'This broad location may include personal or system files. Windows file permissions still apply.'
    : request.kind === 'terminal'
      ? 'Full Terminal can reach beyond approved folder roots. ForgeLink safety rules and Windows permissions still apply.'
      : request.kind === 'windows'
        ? 'Full Windows Control can inspect the desktop and act on exact apps or Settings destinations.'
        : 'The desktop enforcer will restart ForgeLink for a temporary protected-source maintenance window.';
  const warning = highRisk
    ? '<div class="permission-impact-card' + (permissionRiskConfirmed ? ' is-reviewed' : '') + '">' + icon(permissionRiskConfirmed ? 'check' : 'alert') +
      '<div class="permission-impact-copy"><div class="permission-impact-heading"><strong>' +
      (permissionRiskConfirmed ? 'Impact reviewed' : 'High-impact permission') +
      '</strong><span>' + (permissionRiskConfirmed ? 'Ready for final approval' : 'Review required before approval') + '</span></div>' +
      '<p>' + esc(impactText) + '</p></div></div>' : '';
  const error = permissionActionError ? '<div class="workflow-action-error">' + esc(permissionActionError) + '</div>' : '';
  const allowLabel = permissionActionActive
    ? 'Applying…'
    : highRisk && !permissionRiskConfirmed
      ? 'Review impact'
      : request.kind === 'maintenance'
        ? 'Allow for 15 minutes'
        : request.persistent
          ? 'Allow until revoked'
          : 'Allow for 15 minutes';

  root.innerHTML = '<div class="artifact-app access-request-app permission-request-app"><div class="ambient ambient-one"></div><div class="ambient ambient-two"></div>' +
    '<main class="access-request-body permission-request-body"><section class="permission-decision-card">' +
      '<div class="permission-card-head"><div class="permission-brand-lockup"><div class="artifact-logo" role="img" aria-label="ForgeLink"></div>' +
        '<div class="permission-title-copy"><div class="permission-eyebrow"><span>ForgeLink Security</span><span class="permission-dot"></span><span>Approval required</span></div>' +
        '<h1>' + esc(permissionTitle(request)) + '</h1><p>Review this temporary capability before ForgeLink continues. Only your choice in this card can grant it.</p></div></div>' +
        '<span class="permission-stage-pill">' + esc(pending ? decisionStage : humanize(expired ? 'expired' : request.status)) + '</span></div>' +
      '<div class="permission-summary-grid">' +
        '<div class="permission-summary-item"><span>Capability</span><strong>' + esc(permissionLevel(request)) + '</strong></div>' +
        '<div class="permission-summary-item"><span>Duration</span><strong>' + esc(lifetime) + '</strong></div>' +
        '<div class="permission-summary-item permission-summary-wide"><span>Scope</span><code>' + esc(request.scope || '') + '</code></div>' +
      '</div>' +
      '<div class="permission-reason-block"><span>Request reason</span><p>' + esc(request.reason || 'Needed to complete the current task.') + '</p></div>' +
      warning + error + outcome +
      (pending ? '<div class="permission-continuation-note">' + icon('sparkle') + '<div><strong>Continuous chat</strong><span>Your choice resumes this same conversation automatically. You do not need to type “done”, “approved”, or “continue”.</span></div></div>' +
        '<div class="permission-action-footer"><span class="permission-decision-label">Your decision</span><div class="workflow-approval-actions access-request-actions permission-actions">' +
          '<button class="workflow-button workflow-decline permission-deny" id="permission-deny" type="button"' + (permissionActionActive ? ' disabled' : '') + '>' + icon('x') + '<span>Deny</span></button>' +
          '<button class="workflow-button workflow-approve permission-primary" id="permission-allow" type="button"' + (permissionActionActive ? ' disabled' : '') + '>' + icon(highRisk && !permissionRiskConfirmed ? 'shield' : 'check') + '<span>' + esc(allowLabel) + '</span></button></div></div>' : '') +
    '</section></main></div>';

  root.querySelector('#permission-allow')?.addEventListener('click', () => {
    if (highRisk && !permissionRiskConfirmed) { permissionRiskConfirmed = true; renderPermissionRequest(); return; }
    void decideChatPermission('allow');
  });
  root.querySelector('#permission-deny')?.addEventListener('click', () => void decideChatPermission('deny'));
  queueHostSizeReport();
}

function permissionContinuationMessage(request, decision) {
  if (decision === 'allow' && request.kind === 'maintenance') {
    return 'ForgeLink permission card decision: APPROVED for the exact maintenance request shown above. This is the authenticated card-generated continuation in the same conversation. The card waited until the protected backend reconnected and permission_status confirmed maintenance.active=true. Resume the suspended original task now without asking me to type done, approved, continue, or to reconfirm the same permission. Request ID: ' + request.requestId + '.';
  }
  return decision === 'allow'
    ? 'ForgeLink permission card decision: APPROVED for the exact ' + request.kind + ' request shown above. This is the authenticated card-generated continuation in the same conversation. Verify the authoritative permission state, then automatically resume the suspended original task now. Do not ask me to type done, approved, continue, or to reconfirm the same permission. Request ID: ' + request.requestId + '.'
    : 'ForgeLink permission card decision: DENIED for the exact ' + request.kind + ' request shown above. This is the authenticated card-generated continuation in the same conversation. Do not retry or ask me to reconfirm this request; continue only within existing permissions. Request ID: ' + request.requestId + '.';
}

async function sendPermissionContinuation(request, decision) {
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const sent = await app.sendMessage({ role: 'user', content: [{ type: 'text', text: permissionContinuationMessage(request, decision) }] });
      if (!sent?.isError) return;
      lastError = new Error('ChatGPT did not accept the card continuation message.');
    } catch (error) {
      lastError = error;
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 650 * (attempt + 1)));
  }
  throw lastError || new Error('ChatGPT did not accept the card continuation message.');
}

async function decideChatPermission(decision) {
  if (permissionActionActive || !currentPermissionRequest?.requestId) return;
  permissionActionActive = true;
  permissionActionError = '';
  renderPermissionRequest();
  const request = currentPermissionRequest;
  const expiresAt = Date.parse(request.expiresAt || '');
  if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
    currentPermissionRequest = { ...request, status: 'expired' };
    permissionChallenge = '';
    permissionActionActive = false;
    renderPermissionRequest();
    return;
  }

  let authoritativeDecision = '';
  try {
    if (!permissionChallenge) throw new Error('The private approval challenge is unavailable. Refresh this ChatGPT card.');
    if (!app.getHostCapabilities?.()?.serverTools) throw new Error('This ChatGPT host cannot send a permission decision from the card.');
    const response = await app.callServerTool({ name: 'resolve_chat_permission', arguments: {
      requestId: request.requestId, challenge: permissionChallenge, decision,
      acknowledgedRisk: decision === 'allow' && permissionRiskConfirmed,
    } });
    if (response?.isError) throw new Error('ForgeLink rejected this permission decision.');
    const payload = toolResultPayload(response);
    if (!payload?.permissionRequest || !['approved', 'denied'].includes(payload.permissionRequest.status)) throw new Error('ForgeLink did not confirm the permission decision.');
    currentPermissionRequest = payload.permissionRequest;
    permissionChallenge = '';
    authoritativeDecision = payload.permissionRequest.status === 'approved' ? 'allow' : 'deny';
    renderPermissionRequest();

  } catch (error) {
    let reconciled = false;
    try {
      if (request.kind === 'maintenance') {
        const live = toolResultPayload(await app.callServerTool({ name: 'permission_status', arguments: {} }));
        if (live?.maintenance?.active === true) {
          currentPermissionRequest = { ...request, status: 'approved', grant: { status: 'active' } };
          permissionChallenge = '';
          permissionActionError = '';
          authoritativeDecision = 'allow';
          reconciled = true;
        }
      }
      if (!reconciled) {
        const status = toolResultPayload(await app.callServerTool({ name: 'permission_request_status', arguments: { requestId: request.requestId } }));
        if (status?.status === 'expired' || status?.status === 'not_found_or_expired') {
          currentPermissionRequest = { ...request, status: 'expired' };
          permissionChallenge = '';
          permissionActionError = 'This approval request expired. Ask ChatGPT to request it again.';
          reconciled = true;
        } else if (status?.status === 'approved' || status?.status === 'denied') {
          currentPermissionRequest = { ...request, ...status };
          permissionChallenge = '';
          permissionActionError = '';
          authoritativeDecision = status.status === 'approved' ? 'allow' : 'deny';
          reconciled = true;
        }
      }
    } catch {}
    if (!reconciled) permissionActionError = clean(error?.message || error || 'Permission decision failed.');
  }

  if (authoritativeDecision === 'allow' && request.kind === 'maintenance') {
    const deadline = Date.now() + 20_000;
    let active = false;
    let reconnectShown = false;
    currentPermissionRequest = { ...currentPermissionRequest, grant: { ...currentPermissionRequest.grant, status: 'activating' } };
    renderPermissionRequest();

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      try {
        const statusResponse = await app.callServerTool({ name: 'permission_status', arguments: {} });
        if (toolResultPayload(statusResponse)?.maintenance?.active === true) {
          active = true;
          currentPermissionRequest = { ...currentPermissionRequest, grant: { ...currentPermissionRequest.grant, status: 'active' } };
          renderPermissionRequest();
          break;
        }
      } catch {
        if (!reconnectShown) {
          reconnectShown = true;
          currentPermissionRequest = { ...currentPermissionRequest, grant: { ...currentPermissionRequest.grant, status: 'reconnecting' } };
          renderPermissionRequest();
        }
      }
    }

    if (!active && !permissionActionError) {
      permissionActionError = 'Approval was saved, but ForgeLink did not reconnect with protected maintenance within 20 seconds. The chat was not resumed to avoid sending work into an offline backend.';
    }
  }

  if (authoritativeDecision && !permissionActionError) {
    try {
      // For protected maintenance, this runs only after a call to the refreshed
      // backend proves the maintenance lease is active. This avoids waking the
      // next ChatGPT turn while the old MCP generation is being replaced.
      await sendPermissionContinuation(request, authoritativeDecision);
      if (authoritativeDecision === 'allow' && request.kind === 'maintenance') {
        currentPermissionRequest = { ...currentPermissionRequest, grant: { ...currentPermissionRequest.grant, status: 'resumed' } };
        renderPermissionRequest();
      }
    } catch (error) {
      permissionActionError = 'Permission was applied, but automatic same-chat continuation could not be delivered after reconnect: ' + clean(error?.message || error);
    }
  }

  permissionActionActive = false;
  renderPermissionRequest();
}

function renderEmpty() {
  root.innerHTML = '<div class="viewer-state"><div class="artifact-logo artifact-logo-large" role="img" aria-label="ForgeLink"></div>' +
    '<div class="section-kicker">FORGELINK ARTIFACT</div><h2>Waiting for ForgeLink data</h2><p>The MCP Apps viewer is connected and ready for an artifact or security approval request.</p></div>';
  queueHostSizeReport();
}

function render(payload, metadata = {}) {
  const permissionRequest = payload?.permissionRequest;
  if (permissionRequest?.requestId) {
    currentArtifact = null;
    currentArtifactIdentity = '';
    currentAccessRequest = null;
    currentMaintenanceRequest = null;
    currentPermissionRequest = { ...permissionRequest };
    permissionChallenge = clean(metadata?.['forgelink/approvalChallenge'] ||
      window.openai?.toolResponseMetadata?.mcp_tool_result?._meta?.['forgelink/approvalChallenge'] ||
      window.openai?.toolResponseMetadata?.call_tool_result?._meta?.['forgelink/approvalChallenge']);
    permissionActionError = '';
    permissionRiskConfirmed = false;
    renderPermissionRequest();
    return;
  }
  currentPermissionRequest = null;
  permissionChallenge = '';
  const maintenanceRequest = payload?.maintenanceRequest;
  if (maintenanceRequest?.requestId) {
    currentArtifact = null;
    currentArtifactIdentity = "";
    currentAccessRequest = null;
    currentMaintenanceRequest = { ...maintenanceRequest };
    maintenanceActionError = "";
    renderMaintenanceRequest();
    return;
  }

  currentMaintenanceRequest = null;
  const accessRequest = payload?.accessRequest;
  if (accessRequest?.requestId) {
    currentArtifact = null;
    currentArtifactIdentity = "";
    currentAccessRequest = { ...accessRequest };
    accessActionError = "";
    accessRiskConfirmed = false;
    renderAccessRequest();
    return;
  }

  currentAccessRequest = null;
  const item = payload?.artifact || payload;
  const documentValue = item?.document || item;

  if (!documentValue?.title) {
    renderEmpty();
    return;
  }

  const identity = clean(item?.id) || [clean(documentValue.title), clean(documentValue.generatedAt)].join("|");
  if (identity !== currentArtifactIdentity) {
    currentArtifactIdentity = identity;
    artifactExpanded = displayMode === "fullscreen";
    linkedWorkflow = null;
    linkedWorkflowArtifactIdentity = "";
    workflowActionError = "";
  }

  currentArtifact = { item, documentValue };
  const verification = documentValue.verification || [];
  const passed = verification.filter((entry) => entry.passed).length;
  const verifiedAll = verification.length > 0 && passed === verification.length;
  const expandedClass = artifactExpanded ? "is-expanded" : "is-collapsed";
  const toggleLabel = artifactExpanded ? "Collapse artifact" : "View full artifact";
  const previewHeading = clean(documentValue.sections?.[0]?.title) || "Artifact preview";
  const previewCopy = previewText(documentValue);
  const sectionCount = Array.isArray(documentValue.sections) ? documentValue.sections.length : 0;

  root.innerHTML = '<div class="artifact-app ' + expandedClass + '" data-expanded="' + String(artifactExpanded) + '"><div class="ambient ambient-one"></div><div class="ambient ambient-two"></div>' +
    '<header class="artifact-hero"><div class="hero-top"><div class="brand"><div class="artifact-logo" role="img" aria-label="ForgeLink"></div><div class="brand-copy"><span class="brand-name">ForgeLink</span><span class="brand-divider"></span><span class="document-kind">' +
    esc(humanize(documentValue.type || "document")) +
    "</span></div></div>" +
    '<div class="hero-actions" aria-label="Artifact actions">' +
    '<button class="artifact-action-button" id="open-app-tab" type="button" title="Open this artifact in the focused app view" data-default-label="Open app in tab">' + icon("external") + '<span class="button-label">Open app in tab</span></button>' +
    '<button class="artifact-action-button" id="copy-artifact" type="button" title="Copy the complete artifact as Markdown" data-default-label="Copy">' + icon("copy") + '<span class="button-label">Copy</span></button>' +
    '<button class="artifact-action-button" id="download-pdf" type="button" title="Download this artifact as PDF" data-default-label="Download PDF">' + icon("download") + '<span class="button-label">Download PDF</span></button>' +
    "</div></div>" +
    '<div class="hero-content"><div class="hero-eyebrow">FORGELINK ARTIFACT</div><h1>' +
    esc(documentValue.title) + "</h1>" +
    (documentValue.subtitle ? '<p class="hero-subtitle">' + esc(documentValue.subtitle) + "</p>" : "") +
    '<div class="artifact-context-row"><span>' + sectionCount + " " + (sectionCount === 1 ? "section" : "sections") + '</span><span class="context-dot" aria-hidden="true"></span><span>Revision ' + esc(item?.revisions || 1) + "</span></div>" +
    (verification.length ? '<div class="hero-status-row"><div class="hero-status ' + (verifiedAll ? "hero-status-success" : "hero-status-warning") + '">' +
      icon(verifiedAll ? "shield" : "alert") + "<span>" +
      (verifiedAll ? "Verified" : passed + "/" + verification.length + " checks passed") +
      "</span></div></div>" : "") +
    (documentValue.summary ? '<p class="compact-summary">' + esc(documentValue.summary) + "</p>" : "") +
    "</div>" + renderMetadata(documentValue.metadata, item) + "</header>" +
    '<section class="artifact-collapsed-preview" aria-label="Artifact preview"><div class="preview-kicker">PREVIEW</div><h2>' +
    esc(previewHeading) + '</h2><p>' + esc(previewCopy) + '</p><div class="artifact-preview-fade" aria-hidden="true"></div></section>' +
    '<div id="workflow-approval-slot" class="workflow-approval-slot" aria-live="polite"></div>' +
    '<div class="artifact-toggle-row"><button class="artifact-toggle-button" id="toggle-artifact" type="button" aria-expanded="' + String(artifactExpanded) + '" aria-controls="artifact-expanded-content" title="' +
    (artifactExpanded ? "Collapse this artifact in chat" : "View the full artifact in chat") + '"><span class="toggle-label">' + toggleLabel + '</span><span class="toggle-icon">' + icon("chevron") + "</span></button></div>" +
    '<div class="artifact-expanded-content" id="artifact-expanded-content">' +
    (documentValue.summary ? '<section class="executive-card"><div class="executive-accent"></div><div class="executive-header"><div><div class="section-kicker">OVERVIEW</div><h2>Executive Summary</h2></div>' +
      icon("sparkle") + "</div><p>" + esc(documentValue.summary) + "</p></section>" : "") +
    '<main class="artifact-content">' +
    renderSections(documentValue.sections) +
    (!((documentValue.sections || []).some((s) => clean(s.title).toLowerCase() === "verification")) ? renderVerification(verification) : "") +
    (!((documentValue.sections || []).some((s) => clean(s.title).toLowerCase() === "evidence")) ? renderEvidence(documentValue.evidence || []) : "") +
    (!((documentValue.sections || []).some((s) => clean(s.title).toLowerCase() === "walkthrough")) ? renderWalkthrough(documentValue.walkthrough) : "") +
    (!((documentValue.sections || []).some((s) => clean(s.title).toLowerCase() === "limitations")) ? renderLimitations(documentValue.limitations || []) : "") +
    "</main>" +
    '<footer class="artifact-footer"><div class="footer-brand"><span class="footer-logo" aria-hidden="true"></span><span>ForgeLink Artifact Engine</span></div><div class="footer-meta"><span>Schema v' +
    esc(documentValue.schemaVersion || "1") +
    '</span><span class="footer-separator">•</span><span>Revision ' + esc(item?.revisions || 1) + "</span>" +
    (documentValue.generatedAt ? '<span class="footer-separator">•</span><span>' + esc(formatDate(documentValue.generatedAt)) + "</span>" : "") +
    '</div></footer></div></div>';

  root.querySelector("#toggle-artifact")?.addEventListener("click", () => setArtifactExpanded(!artifactExpanded));
  root.querySelector("#open-app-tab")?.addEventListener("click", (event) => void openArtifactAppView(event.currentTarget));
  root.querySelector("#copy-artifact")?.addEventListener("click", (event) => void copyCurrentArtifact(event.currentTarget));
  root.querySelector("#download-pdf")?.addEventListener("click", (event) => {
    void downloadCurrentArtifact(event.currentTarget);
  });

  renderWorkflowApproval();
  void refreshLinkedWorkflow();
  queueHostSizeReport();
}

function applyHostContext(context) {
  if (!context) return;
  if (context.theme) document.documentElement.dataset.theme = context.theme;

  const previousDisplayMode = displayMode;
  if (context.displayMode) {
    displayMode = context.displayMode;
    document.documentElement.dataset.displayMode = displayMode;
  }

  if (currentArtifact && previousDisplayMode !== "fullscreen" && displayMode === "fullscreen") {
    expandedBeforeFullscreen = pendingFullscreenPreviousExpanded ?? artifactExpanded;
    pendingFullscreenPreviousExpanded = null;
    setArtifactExpanded(true);
  } else if (currentArtifact && previousDisplayMode === "fullscreen" && displayMode !== "fullscreen") {
    setArtifactExpanded(expandedBeforeFullscreen);
  }

  const variables = context.styles?.variables;
  if (variables) {
    for (const [key, value] of Object.entries(variables)) {
      if (typeof value === "string" && key.startsWith("--")) {
        document.documentElement.style.setProperty(key, value);
      }
    }
  }

  queueHostSizeReport();
}

const app = new App(
  { name: "forgelink-artifact-viewer", version: "4.0.0" },
  { availableDisplayModes: ["inline", "fullscreen"] },
  { autoResize: false, strict: true },
);

app.ontoolresult = (params) => {
  render(params?.structuredContent, params?._meta);
};

app.onhostcontextchanged = (params) => {
  applyHostContext(params);
};

async function start() {
  try {
    renderEmpty();
    await app.connect();
    appConnected = true;
    applyHostContext(app.getHostContext());

    if (window.openai?.toolOutput) {
      render(window.openai.toolOutput, window.openai?.toolResponseMetadata?.mcp_tool_result?._meta || window.openai?.toolResponseMetadata?.call_tool_result?._meta);
    }
  } catch (error) {
    console.error("ForgeLink artifact viewer failed to initialize", error);
    root.innerHTML = '<div class="viewer-state viewer-state-error"><div class="viewer-state-icon">' + icon("alert") +
      '</div><div class="section-kicker">FORGELINK ARTIFACT</div><h2>Viewer initialization failed</h2><p>ForgeLink could not establish the MCP Apps bridge with the host.</p></div>';
  }
}

void start();
