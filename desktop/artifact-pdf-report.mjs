import { jsPDF } from "jspdf";
import { marked } from "marked";

const clean = (v) => String(v ?? "").trim();
const humanize = (v) => clean(v).replace(/[-_]+/g, " ").replace(/\b\w/g, c => c.toUpperCase());
const safe = (v) => String(v ?? "")
  .replace(/[\u2013\u2014]/g, "-")
  .replace(/\u2022/g, "•")
  .replace(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\u00FF\u2022]/g, "?");

const textOf = (tokens = []) => tokens.map((t) => {
  if (!t) return "";
  if (typeof t.text === "string" && (!Array.isArray(t.tokens) || !t.tokens.length)) return t.text;
  if (Array.isArray(t.tokens)) return textOf(t.tokens);
  return "";
}).join("");

function chartSpec(source) {
  try {
    const raw = JSON.parse(clean(source));
    const type = ["bar", "line"].includes(clean(raw.type).toLowerCase()) ? clean(raw.type).toLowerCase() : null;
    const labels = Array.isArray(raw.labels) ? raw.labels.map(clean).filter(Boolean).slice(0, 16) : [];
    let series = Array.isArray(raw.series) ? raw.series : [];
    if (!series.length && Array.isArray(raw.values)) {
      series = [{ name: clean(raw.label || "Value"), values: raw.values }];
    }
    series = series.slice(0, 4).map((s, i) => ({
      name: clean(s?.name || ("Series " + (i + 1))),
      values: Array.isArray(s?.values) ? s.values.map(Number) : [],
    }));
    const count = Math.min(labels.length, ...series.map((s) => s.values.length));
    if (!type || !series.length || count < 2) return null;
    series = series.map((s) => ({ ...s, values: s.values.slice(0, count) }));
    if (series.some((s) => s.values.some((v) => !Number.isFinite(v)))) return null;
    const values = series.flatMap((s) => s.values);
    let min = Math.min(0, ...values);
    let max = Math.max(0, ...values);
    if (min === max) max = min + 1;
    return {
      type,
      title: clean(raw.title || "Chart"),
      description: clean(raw.description),
      labels: labels.slice(0, count),
      series,
      min,
      max,
    };
  } catch {
    return null;
  }
}

const fmt = (n) => {
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return Number.isInteger(n) ? String(n) : Number(n).toFixed(1);
};

function roleFor(asset = {}, hint = {}) {
  const declared = clean(asset.role || hint.role).toLowerCase();
  if (["logo", "screenshot", "diagram", "photo", "generic"].includes(declared)) return declared;
  if (clean(asset.placement || hint.placement).toLowerCase() === "hero") return "logo";
  const s = [asset.id, asset.alt, asset.title, asset.source?.path, hint.alt, hint.title, hint.source]
    .filter(Boolean).join(" ").toLowerCase();
  if (/\b(logo|logomark|brandmark|wordmark|app[-_ ]?icon|favicon)\b/.test(s)) return "logo";
  if (/\b(screenshot|screen[-_ ]?shot|dashboard|app[-_ ]?screen|window|ui[-_ ]?preview)\b/.test(s)) return "screenshot";
  if (/\b(diagram|architecture|flowchart|schema|topology|wireframe)\b/.test(s)) return "diagram";
  if (/\b(photo|photograph|portrait|camera|gallery)\b/.test(s)) return "photo";
  return "generic";
}

export async function generateArtifactReportPdf({ artifact, resolveImage }) {
  const d = artifact?.document || artifact || {};
  const doc = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });

  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 18;
  const UW = W - 2 * M;
  const TOP = 25;
  const BOTTOM = H - 20;

  const C = {
    ink: [24, 29, 39],
    body: [57, 64, 76],
    muted: [101, 109, 123],
    subtle: [137, 145, 158],
    border: [222, 226, 233],
    soft: [247, 248, 251],
    accent: [91, 78, 246],
    accentSoft: [240, 238, 255],
    blue: [49, 101, 218],
    green: [24, 137, 94],
    amber: [204, 135, 28],
    navy: [20, 25, 36],
    white: [255, 255, 255],
  };

  const meta = d.metadata || {};
  const mv = (...keys) => {
    for (const k of keys) if (clean(meta[k])) return String(meta[k]);
    return "";
  };

  const project = mv("project", "projectName") || d.title || "Technical Report";
  const reportType = humanize(d.type || "technical-report");
  const purpose = mv("purpose", "documentPurpose") || reportType;
  const preparedBy = mv("preparedBy", "author", "student", "owner");
  const preparedFor = mv("preparedFor", "institution", "organization", "company", "college", "university");
  const department = mv("department", "program", "branch");
  const revision = String(artifact?.revisions || 1);
  const date = new Date(d.generatedAt || artifact?.updatedAt || Date.now())
    .toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });

  const markdown = clean(d.content || d.markdown);
  const tokens = marked.lexer(markdown, { gfm: true });

  const toc = [];
  let y = TOP;
  let sec = 0;
  let sub = 0;
  let minor = 0;
  let fig = 0;
  let table = 0;

  const page = () => doc.internal.getNumberOfPages();

  const set = (size, style = "normal", color = C.body, font = "helvetica") => {
    doc.setFont(font, style);
    doc.setFontSize(size);
    doc.setTextColor(...color);
  };

  const newPage = () => {
    doc.addPage();
    y = TOP;
  };

  const ensure = (h) => {
    if (y + h > BOTTOM) newPage();
  };

  const write = (value, {
    size = 10.1,
    style = "normal",
    color = C.body,
    gap = 4,
    width = UW,
    x = M,
    font = "helvetica",
    leading = null,
  } = {}) => {
    value = safe(value);
    if (!clean(value)) return;
    set(size, style, color, font);
    const lines = doc.splitTextToSize(value, width);
    const lh = leading || Math.max(4.5, size * 0.46);
    ensure(lines.length * lh + gap);
    doc.text(lines, x, y);
    y += lines.length * lh + gap;
  };

  const rows = [
    ["Project", project],
    ["Document", reportType],
    ["Purpose", purpose],
    ["Revision", revision],
    ["Date", date],
  ];
  if (preparedBy) rows.push(["Prepared by", preparedBy]);
  if (preparedFor) rows.push(["Prepared for", preparedFor]);
  if (department) rows.push(["Department", department]);

  let coverLogo = null;
  const logoAsset = (d.assets || []).find((a) => roleFor(a) === "logo");
  if (logoAsset && resolveImage) {
    try {
      coverLogo = await resolveImage("asset:" + logoAsset.id, { asset: logoAsset });
    } catch {}
  }

  doc.setFillColor(...C.white);
  doc.rect(0, 0, W, H, "F");
  doc.setFillColor(...C.navy);
  doc.rect(0, 0, W, 111, "F");
  doc.setFillColor(...C.accent);
  doc.rect(0, 0, 4.2, 111, "F");
  doc.setFillColor(38, 44, 59);
  doc.circle(W - 16, 18, 38, "F");
  doc.setFillColor(31, 37, 51);
  doc.circle(W - 2, 51, 48, "F");

  set(8.3, "bold", [190, 185, 255]);
  doc.text(reportType.toUpperCase(), M, 20);
  set(7.5, "normal", [174, 182, 197]);
  doc.text("PROFESSIONAL TECHNICAL REPORT", M, 27);

  if (coverLogo?.dataUrl) {
    try {
      const p = doc.getImageProperties(coverLogo.dataUrl);
      const ar = p.width / Math.max(1, p.height);
      let h = 20;
      let w = h * ar;
      if (w > 32) {
        w = 32;
        h = w / ar;
      }
      doc.addImage(coverLogo.dataUrl, p.fileType || undefined, W - M - w, 17, w, h);
    } catch {}
  }

  set(25, "bold", C.white);
  const titleLines = doc.splitTextToSize(safe(d.title || "Technical Report"), 162);
  doc.text(titleLines, M, 49);
  const titleBottom = 49 + titleLines.length * 10.4;

  if (d.subtitle) {
    set(10.5, "normal", [198, 205, 216]);
    doc.text(doc.splitTextToSize(safe(d.subtitle), 160), M, Math.min(91, titleBottom + 5));
  }

  let cy = 128;
  set(8.2, "bold", C.accent);
  doc.text("EXECUTIVE OVERVIEW", M, cy);
  cy += 8;

  if (d.summary) {
    set(10.2, "normal", C.body);
    const ls = doc.splitTextToSize(safe(d.summary), UW).slice(0, 7);
    doc.text(ls, M, cy);
    cy += ls.length * 4.8 + 10;
  }

  set(8.2, "bold", C.accent);
  doc.text("DOCUMENT CONTROL", M, cy);
  cy += 6;

  const rh = 9.2;
  const labelWidth = 36;
  const controlHeight = rows.length * rh + 4;

  doc.setFillColor(...C.soft);
  doc.setDrawColor(...C.border);
  doc.roundedRect(M, cy, UW, controlHeight, 2.5, 2.5, "FD");

  rows.forEach(([k, v], i) => {
    const ry = cy + 5.7 + i * rh;
    if (i) {
      doc.setDrawColor(232, 235, 240);
      doc.line(M + 3, cy + i * rh + 2, W - M - 3, cy + i * rh + 2);
    }
    set(7.5, "bold", C.muted);
    doc.text(k.toUpperCase(), M + 5, ry);
    set(8.8, "normal", C.ink);
    doc.text(doc.splitTextToSize(safe(v), UW - labelWidth - 10).slice(0, 2), M + labelWidth, ry);
  });

  set(7.3, "normal", C.subtle);
  doc.text(project + "  •  Revision " + revision, M, H - 11);
  doc.text(date, W - M, H - 11, { align: "right" });

  const headingCount = tokens.filter((t) =>
    t?.type === "heading" && Number(t.depth) >= 2 && Number(t.depth) <= 3
  ).length;

  const tocPages = [];
  const tocCap = 23;
  const tocCount = Math.max(1, Math.min(3, Math.ceil(Math.max(1, headingCount) / tocCap)));

  for (let i = 0; i < tocCount; i++) {
    doc.addPage();
    tocPages.push(page());
  }

  doc.addPage();
  const bodyStart = page();
  y = TOP;

  const heading = (value, depth = 2) => {
    value = clean(value);
    if (!value) return;
    if (depth === 1 && value.toLowerCase() === clean(d.title).toLowerCase()) return;

    let no = "";
    if (depth <= 2) {
      sec++;
      sub = 0;
      minor = 0;
      no = String(sec);
    } else if (depth === 3) {
      sub++;
      minor = 0;
      no = sec + "." + sub;
    } else {
      minor++;
      no = sec + "." + sub + "." + minor;
    }

    ensure(depth <= 2 ? 28 : 18);

    if (depth <= 2) {
      if (y > TOP + 5) y += 4;
      doc.setFillColor(...C.accent);
      doc.roundedRect(M, y - 4, 10, 7, 1.5, 1.5, "F");
      set(7.6, "bold", C.white);
      doc.text(no, M + 5, y + 0.7, { align: "center" });

      set(15.5, "bold", C.ink);
      const ls = doc.splitTextToSize(safe(value), UW - 16);
      doc.text(ls, M + 15, y);
      y += ls.length * 6.5 + 6;

      doc.setDrawColor(...C.border);
      doc.line(M, y - 2.5, W - M, y - 2.5);
      toc.push({ level: 2, no, title: value, p: page() });
    } else {
      set(depth === 3 ? 11.5 : 10.4, "bold", depth === 3 ? C.ink : C.body);
      const ls = doc.splitTextToSize(safe(no + "  " + value), UW);
      doc.text(ls, M, y);
      y += ls.length * (depth === 3 ? 5.2 : 4.8) + 4;
      if (depth === 3) toc.push({ level: 3, no, title: value, p: page() });
    }
  };

  const listItem = (value, label, depth = 0, ordered = false) => {
    const left = M + Math.min(depth * 5, 15);
    const lw = ordered ? 10 : 7;
    set(9.7, "normal", C.body);
    const ls = doc.splitTextToSize(safe(value), UW - (left - M) - lw);
    const lead = 4.5;
    ensure(ls.length * lead + 2.2);

    if (ordered) {
      set(8.4, "bold", C.accent);
      doc.text(label, left + 4, y, { align: "right" });
    } else {
      doc.setFillColor(...C.accent);
      doc.circle(left + 2.2, y - 1.25, 1.05, "F");
    }

    set(9.7, "normal", C.body);
    doc.text(ls, left + lw, y);
    y += ls.length * lead + 2.2;
  };

  const codePanel = (src, lang = "code") => {
    const lines = String(src || "").replace(/\r/g, "").split("\n");
    const lead = 3.6;
    let i = 0;

    while (i < lines.length) {
      if (BOTTOM - y < 28) newPage();

      const n = Math.max(4, Math.floor((BOTTOM - y - 16) / lead));
      const chunk = lines.slice(i, i + n);
      const h = 11 + chunk.length * lead;

      doc.setFillColor(243, 245, 248);
      doc.setDrawColor(...C.border);
      doc.roundedRect(M, y, UW, h, 2, 2, "FD");
      doc.setFillColor(...C.navy);
      doc.roundedRect(M, y, UW, 8, 2, 2, "F");
      doc.rect(M, y + 5, UW, 3, "F");

      set(7.1, "bold", [211, 216, 225]);
      doc.text(humanize(lang).toUpperCase(), M + 5, y + 5.3);

      set(7.7, "normal", [48, 54, 64], "courier");
      doc.text(chunk.map(safe), M + 5, y + 13);

      y += h + 5;
      i += chunk.length;
    }
  };

  const architecture = (src) => {
    const groups = [];
    let current = null;

    for (const rawLine of String(src || "").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;

      const h = line.match(/^\[([^\]]+)\]$/);
      if (h) {
        current = { title: h[1], items: [] };
        groups.push(current);
      } else if (current) {
        current.items.push(line.replace(/^(?:->|→)\s*/, ""));
      }
    }

    if (groups.length < 2) {
      codePanel(src, "architecture");
      return;
    }

    fig++;
    set(8, "bold", C.accent);
    doc.text(("FIGURE " + fig).toUpperCase(), M, y);
    y += 5;

    set(11.2, "bold", C.ink);
    doc.text("System architecture", M, y);
    y += 7;

    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      const itemLines = g.items.map((it) => doc.splitTextToSize(safe(it), UW - 35));
      const h = 12 + itemLines.reduce((a, ls) => a + Math.max(5, ls.length * 4), 0);

      ensure(h + 8);

      doc.setFillColor(...C.soft);
      doc.setDrawColor(...C.border);
      doc.roundedRect(M + 8, y, UW - 16, h, 2.5, 2.5, "FD");

      doc.setFillColor(...C.accentSoft);
      doc.roundedRect(M + 8, y, UW - 16, 9, 2.5, 2.5, "F");
      doc.rect(M + 8, y + 6, UW - 16, 3, "F");

      set(9, "bold", C.accent);
      doc.text(safe(g.title), M + 13, y + 6.1);

      let iy = y + 14;
      itemLines.forEach((ls) => {
        doc.setFillColor(...C.accent);
        doc.circle(M + 14, iy - 1.2, 0.8, "F");
        set(8.7, "normal", C.body);
        doc.text(ls, M + 18, iy);
        iy += Math.max(5, ls.length * 4);
      });

      y += h;

      if (gi < groups.length - 1) {
        doc.setDrawColor(...C.accent);
        doc.line(W / 2, y + 1, W / 2, y + 6);
        doc.line(W / 2 - 1.5, y + 4.2, W / 2, y + 6);
        doc.line(W / 2 + 1.5, y + 4.2, W / 2, y + 6);
        y += 8;
      } else {
        y += 6;
      }
    }
  };

  const chart = (src) => {
    const s = chartSpec(src);
    if (!s) {
      codePanel(src, "chart");
      return;
    }

    fig++;
    ensure(100);

    set(8, "bold", C.accent);
    doc.text(("FIGURE " + fig).toUpperCase(), M, y);
    y += 5;

    set(11.5, "bold", C.ink);
    doc.text(safe(s.title), M, y);
    y += 5;

    if (s.description) write(s.description, { size: 8.2, color: C.muted, gap: 3 });

    const h = 74;
    const cardY = y;

    doc.setFillColor(...C.soft);
    doc.setDrawColor(...C.border);
    doc.roundedRect(M, cardY, UW, h, 2.5, 2.5, "FD");

    const colors = [C.accent, C.blue, C.green, C.amber];
    let lx = M + 7;

    s.series.forEach((series, i) => {
      doc.setFillColor(...colors[i]);
      doc.roundedRect(lx, cardY + 4.6, 3.8, 3.8, 0.8, 0.8, "F");
      set(7.2, "normal", C.muted);
      doc.text(safe(series.name), lx + 5.2, cardY + 7.7);
      lx += 9 + Math.min(36, doc.getTextWidth(safe(series.name)));
    });

    const x0 = M + 15;
    const py = cardY + 15;
    const pw = UW - 25;
    const ph = h - 27;
    const range = s.max - s.min;
    const yFor = (v) => py + ph - ((v - s.min) / range) * ph;

    for (let i = 0; i <= 4; i++) {
      const ratio = i / 4;
      const gy = py + ph * ratio;
      const value = s.max - range * ratio;

      doc.setDrawColor(225, 228, 234);
      doc.line(x0, gy, x0 + pw, gy);

      set(6.5, "normal", C.subtle);
      doc.text(fmt(value), x0 - 3, gy + 1.1, { align: "right" });
    }

    const step = pw / s.labels.length;

    if (s.type === "bar") {
      const groupWidth = step * 0.7;
      const barWidth = Math.max(2, groupWidth / s.series.length);
      const zeroY = yFor(0);

      s.series.forEach((series, seriesIndex) => {
        doc.setFillColor(...colors[seriesIndex]);
        series.values.forEach((value, i) => {
          const valueY = yFor(value);
          const bx = x0 + i * step + (step - groupWidth) / 2 + seriesIndex * barWidth;
          const bh = Math.max(0.8, Math.abs(zeroY - valueY));
          doc.roundedRect(
            bx,
            Math.min(zeroY, valueY),
            Math.max(1.4, barWidth - 1),
            bh,
            0.6,
            0.6,
            "F",
          );
          set(6.2, "bold", C.muted);
          doc.text(
            fmt(value),
            bx + Math.max(1.4, barWidth - 1) / 2,
            Math.min(zeroY, valueY) - 1.2,
            { align: "center" },
          );
        });
      });
    } else {
      s.series.forEach((series, seriesIndex) => {
        doc.setDrawColor(...colors[seriesIndex]);
        doc.setLineWidth(0.8);
        for (let i = 1; i < series.values.length; i++) {
          doc.line(
            x0 + step * (i - 0.5),
            yFor(series.values[i - 1]),
            x0 + step * (i + 0.5),
            yFor(series.values[i]),
          );
        }
      });
    }

    s.labels.forEach((label, i) => {
      set(6.6, "normal", C.muted);
      doc.text(safe(label).slice(0, 15), x0 + step * (i + 0.5), py + ph + 5.5, { align: "center" });
    });

    y += h + 7;
  };

  const drawTable = (headers, rowsData) => {
    const headersSafe = headers.map(safe);
    const rowsSafe = rowsData.map((r) => r.map(safe));
    const cols = Math.max(1, headersSafe.length || rowsSafe[0]?.length || 1);
    const colWidth = UW / cols;
    const fontSize = cols >= 5 ? 7.2 : cols >= 4 ? 7.7 : 8.2;
    const lineHeight = fontSize * 0.45;

    table++;
    set(8, "bold", C.accent);
    doc.text(("TABLE " + table).toUpperCase(), M, y);
    y += 5;

    const drawHeader = () => {
      const lines = headersSafe.map((v) => {
        set(fontSize, "bold", C.white);
        return doc.splitTextToSize(v, colWidth - 5);
      });

      const hh = Math.max(9, Math.max(1, ...lines.map((x) => x.length)) * lineHeight + 5);
      ensure(hh + 2);

      doc.setFillColor(...C.navy);
      doc.rect(M, y, UW, hh, "F");

      lines.forEach((x, i) => {
        set(fontSize, "bold", C.white);
        doc.text(x, M + i * colWidth + 2.5, y + 5.2);
      });

      y += hh;
    };

    if (headersSafe.length) drawHeader();

    rowsSafe.forEach((row, rowIndex) => {
      const cells = Array.from({ length: cols }, (_, i) => row[i] || "");
      const lines = cells.map((v) => doc.splitTextToSize(v, colWidth - 5));
      const hh = Math.max(8, Math.max(1, ...lines.map((x) => x.length)) * lineHeight + 4.5);

      if (y + hh > BOTTOM) {
        newPage();
        if (headersSafe.length) drawHeader();
      }

      if (rowIndex % 2 === 0) {
        doc.setFillColor(...C.soft);
        doc.rect(M, y, UW, hh, "F");
      }

      doc.setDrawColor(...C.border);
      doc.rect(M, y, UW, hh);

      lines.forEach((x, i) => {
        if (i) doc.line(M + i * colWidth, y, M + i * colWidth, y + hh);
        set(fontSize, "normal", C.body);
        doc.text(x, M + i * colWidth + 2.5, y + 4.8);
      });

      y += hh;
    });

    y += 6;
  };

  const addImage = async (token) => {
    if (!resolveImage) return;

    let img;
    try {
      img = await resolveImage(clean(token.href), { alt: token.text, title: token.title });
    } catch {
      return;
    }

    if (!img?.dataUrl) return;

    const role = roleFor(
      img.asset || {},
      { role: img.role, alt: token.text, title: token.title, source: token.href },
    );

    if (role === "logo") return;

    fig++;

    let props;
    try {
      props = doc.getImageProperties(img.dataUrl);
    } catch {
      return;
    }

    const ar = props.width / Math.max(1, props.height);
    const maxW = role === "screenshot" ? UW - 8 : role === "diagram" ? UW - 16 : UW - 24;
    const maxH = role === "screenshot" ? 112 : 108;

    let w = maxW;
    let h = w / ar;

    if (h > maxH) {
      h = maxH;
      w = h * ar;
    }

    ensure(h + 22);

    const x = M + (UW - w) / 2;

    if (role === "screenshot") {
      doc.setFillColor(...C.navy);
      doc.roundedRect(x - 3, y, w + 6, h + 11, 2.5, 2.5, "F");
      doc.addImage(img.dataUrl, props.fileType || undefined, x, y + 8, w, h);
      y += h + 13;
    } else {
      if (role === "diagram") {
        doc.setFillColor(...C.soft);
        doc.setDrawColor(...C.border);
        doc.roundedRect(x - 4, y - 3, w + 8, h + 6, 2.5, 2.5, "FD");
      }
      doc.addImage(img.dataUrl, props.fileType || undefined, x, y, w, h);
      y += h + 5;
    }

    const caption = clean(img.title || token.title || token.text);
    if (caption) {
      set(8, "italic", C.muted);
      const ls = doc.splitTextToSize(safe("Figure " + fig + ". " + caption), UW - 18);
      doc.text(ls, W / 2, y, { align: "center" });
      y += ls.length * 3.7 + 5;
    }
  };

  let intro = false;

  const render = async (list, depth = 0) => {
    for (const token of list || []) {
      if (!token || token.type === "space") continue;

      if (token.type === "heading") {
        heading(textOf(token.tokens), Number(token.depth) || 2);
      } else if (token.type === "paragraph") {
        const inline = (token.tokens || []).filter((x) => x?.type && x.type !== "space");

        if (inline.length && inline.every((x) => x.type === "image")) {
          for (const x of inline) await addImage(x);
          continue;
        }

        if (!intro && sec === 0) {
          set(8, "bold", C.accent);
          doc.text("INTRODUCTION", M, y);
          y += 6;
          intro = true;
        }

        write(textOf(token.tokens), { leading: 4.75, gap: 4.4 });
      } else if (token.type === "list") {
        let n = Number(token.start) || 1;
        for (const item of token.items || []) {
          listItem(
            textOf(item.tokens),
            token.ordered ? ((n++) + ".") : "",
            depth,
            Boolean(token.ordered),
          );
        }
        y += 2;
      } else if (token.type === "blockquote") {
        write(textOf(token.tokens), {
          size: 9.5,
          style: "italic",
          color: C.muted,
          x: M + 7,
          width: UW - 14,
          gap: 5,
        });
      } else if (token.type === "code") {
        const lang = clean(token.lang).split(/\s+/)[0].toLowerCase();
        if (["chart", "graph"].includes(lang)) chart(token.text);
        else if (["architecture", "flowchart", "diagram"].includes(lang)) architecture(token.text);
        else codePanel(token.text, lang || "code");
      } else if (token.type === "image") {
        await addImage(token);
      } else if (token.type === "table") {
        drawTable(
          (token.header || []).map((cell) => textOf(cell.tokens)),
          (token.rows || []).map((row) => row.map((cell) => textOf(cell.tokens))),
        );
      } else if (token.type === "hr") {
        doc.setDrawColor(...C.border);
        doc.line(M, y, W - M, y);
        y += 7;
      } else if (Array.isArray(token.tokens)) {
        await render(token.tokens, depth + 1);
      }
    }
  };

  await render(tokens);

  ensure(22);
  y += 3;
  doc.setDrawColor(...C.border);
  doc.line(M, y, W - M, y);
  y += 8;

  set(7.5, "bold", C.accent);
  doc.text("END OF REPORT", M, y);

  set(7.5, "normal", C.subtle);
  doc.text("Revision " + revision + "  •  " + date, W - M, y, { align: "right" });

  const finalPage = page();
  const bodyPages = finalPage - bodyStart + 1;

  tocPages.forEach((p, tocIndex) => {
    doc.setPage(p);
    doc.setFillColor(...C.white);
    doc.rect(0, 0, W, H, "F");

    set(8, "bold", C.accent);
    doc.text(tocIndex === 0 ? "REPORT NAVIGATION" : "REPORT NAVIGATION · CONTINUED", M, 24);

    set(22, "bold", C.ink);
    doc.text(tocIndex === 0 ? "Table of Contents" : "Contents", M, 38);

    set(8.5, "normal", C.muted);
    doc.text(project + "  •  " + reportType, M, 46);

    doc.setDrawColor(...C.border);
    doc.line(M, 52, W - M, 52);

    let tocY = 63;

    toc.slice(tocIndex * tocCap, (tocIndex + 1) * tocCap).forEach((entry) => {
      const indent = entry.level === 3 ? 7 : 0;
      const size = entry.level === 3 ? 8.4 : 9.3;
      const style = entry.level === 3 ? "normal" : "bold";
      const pageNumber = entry.p - bodyStart + 1;

      set(size, style, entry.level === 3 ? C.muted : C.ink);

      const text = doc.splitTextToSize(
        safe(entry.no + "  " + entry.title),
        UW - indent - 16,
      )[0] || "";

      const startX = M + indent;
      doc.text(text, startX, tocY);

      const textWidth = doc.getTextWidth(text);
      const lineStart = Math.min(W - M - 16, startX + textWidth + 3);

      if (lineStart < W - M - 12) {
        doc.setDrawColor(216, 220, 228);
        doc.line(lineStart, tocY - 0.8, W - M - 11, tocY - 0.8);
      }

      set(size, "bold", C.accent);
      doc.text(String(pageNumber), W - M, tocY, { align: "right" });

      tocY += entry.level === 3 ? 7 : 8.2;
    });

    set(7.2, "normal", C.subtle);
    doc.text("Contents", M, H - 10);
    doc.text(String(tocIndex + 1) + " / " + tocCount, W - M, H - 10, { align: "right" });
  });

  for (let p = bodyStart; p <= finalPage; p++) {
    doc.setPage(p);
    const bodyPage = p - bodyStart + 1;

    set(7.2, "bold", C.muted);
    doc.text(safe(project).slice(0, 52).toUpperCase(), M, 11);

    set(7.2, "normal", C.subtle);
    doc.text(reportType.toUpperCase(), W - M, 11, { align: "right" });

    doc.setDrawColor(...C.border);
    doc.line(M, 15, W - M, 15);
    doc.line(M, H - 15, W - M, H - 15);

    set(7, "normal", C.subtle);
    doc.text("Revision " + revision + "  •  " + date, M, H - 9);
    doc.text("Page " + bodyPage + " of " + bodyPages, W - M, H - 9, { align: "right" });
  }

  const bytes = Buffer.from(doc.output("arraybuffer"));

  return {
    bytes,
    pageCount: doc.internal.getNumberOfPages(),
    tocEntries: toc.length,
  };
}
