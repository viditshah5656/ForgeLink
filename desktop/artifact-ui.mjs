import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

function loadForgeLinkLogoDataUri() {
  const candidates = [
    path.resolve(moduleDir, "..", "logo.png"),
    path.resolve(moduleDir, "logo.png"),
  ];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    return "data:image/png;base64," + fs.readFileSync(candidate).toString("base64");
  }

  return "";
}

const forgeLinkLogoDataUri = loadForgeLinkLogoDataUri();

export const ARTIFACT_UI_URI = "ui://forgelink/presentation-artifact-v19.html";
export const ARTIFACT_UI_ROTATION_URIS = Object.freeze([
  "ui://forgelink/presentation-artifact-slot-a.html",
  "ui://forgelink/presentation-artifact-slot-b.html",
  "ui://forgelink/presentation-artifact-slot-c.html",
  "ui://forgelink/presentation-artifact-slot-d.html",
  "ui://forgelink/presentation-artifact-slot-e.html",
  "ui://forgelink/presentation-artifact-slot-f.html",
  "ui://forgelink/presentation-artifact-slot-g.html",
  "ui://forgelink/presentation-artifact-slot-h.html",
]);
export const PERMISSION_UI_URI = "ui://forgelink/permission-approval-v5.html";
export const ARTIFACT_UI_LEGACY_URI = "ui://forgelink/presentation-artifact-v1.html";
export const ARTIFACT_UI_LEGACY_URIS = [
  "ui://forgelink/presentation-artifact-v1.html",
  "ui://forgelink/presentation-artifact-v2.html",
  "ui://forgelink/presentation-artifact-v3.html",
  "ui://forgelink/presentation-artifact-v4.html",
  "ui://forgelink/presentation-artifact-v5.html",
  "ui://forgelink/presentation-artifact-v6.html",
  "ui://forgelink/presentation-artifact-v7.html",
  "ui://forgelink/presentation-artifact-v8.html",
  "ui://forgelink/presentation-artifact-v9.html",
  "ui://forgelink/presentation-artifact-v10.html",
  "ui://forgelink/presentation-artifact-v11.html",
  "ui://forgelink/presentation-artifact-v12.html",
  "ui://forgelink/presentation-artifact-v13.html",
  "ui://forgelink/presentation-artifact-v14.html",
  "ui://forgelink/presentation-artifact-v15.html",
  "ui://forgelink/presentation-artifact-v16.html",
  "ui://forgelink/presentation-artifact-v17.html",
  "ui://forgelink/presentation-artifact-v18.html",
];

const clientBundlePath = [
  path.join(moduleDir, 'artifact-ui-client.bundle.js'),
  path.join(moduleDir, '..', 'desktop', 'artifact-ui-client.bundle.js'),
  ...(process.env.MCP_ASSET_DIR ? [path.join(process.env.MCP_ASSET_DIR, 'artifact-ui-client.bundle.js')] : []),
].find((candidate) => fs.existsSync(candidate));
const clientSourcePath = [
  path.join(moduleDir, 'artifact-ui-client.js'),
  path.join(moduleDir, '..', 'desktop', 'artifact-ui-client.js'),
  ...(process.env.MCP_ASSET_DIR ? [path.join(process.env.MCP_ASSET_DIR, 'artifact-ui-client.js')] : []),
].find((candidate) => fs.existsSync(candidate));
if (!clientBundlePath) throw new Error('ForgeLink artifact UI bundle is missing from the backend resources.');

function assertArtifactClientBundleFresh() {
  if (!clientSourcePath || !fs.existsSync(clientSourcePath)) return;
  const sourceContents = fs.readFileSync(clientSourcePath);
  if (sourceContents.length === 0) {
    console.warn('[ForgeLink] Artifact UI source is empty; using the last built bundle.');
    return;
  }
  const sourceHash = crypto.createHash('sha256').update(sourceContents).digest('hex');
  const marker = 'FORGELINK_SOURCE_SHA256:' + sourceHash;
  const header = fs.readFileSync(clientBundlePath, 'utf8').slice(0, 256);
  if (!header.includes(marker)) {
    if (header.includes('FORGELINK_SOURCE_SHA256:') && fs.statSync(clientBundlePath).mtimeMs > fs.statSync(clientSourcePath).mtimeMs) {
      console.warn('[ForgeLink] Artifact UI source is older than its built bundle; using the newer bundle.');
      return;
    }
    throw new Error('ForgeLink artifact UI bundle is stale. Run npm run build:artifact-ui before serving artifacts.');
  }
}
assertArtifactClientBundleFresh();
const clientBundle = fs.readFileSync(clientBundlePath, 'utf8').replace(/<\/script/gi, '<\\/script');

export function getLatestArtifactUiHtml() {
  try {
    if (clientBundlePath && fs.existsSync(clientBundlePath)) {
      assertArtifactClientBundleFresh();
      const freshBundle = fs.readFileSync(clientBundlePath, 'utf8').replace(/<\/script/gi, '<\\/script');
      const scriptOpen = '<script type="module">';
      const splitIdx = ARTIFACT_UI_HTML.indexOf(scriptOpen);
      if (splitIdx > 0) {
        return ARTIFACT_UI_HTML.slice(0, splitIdx + scriptOpen.length) + freshBundle + '</script>\n</body>\n</html>';
      }
    }
  } catch {}
  return ARTIFACT_UI_HTML;
}

export const ARTIFACT_UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ForgeLink Artifact</title>
<style>
:root {
  color-scheme: light dark;
  --fl-bg: var(--color-background-primary, #f5f7fb);
  --fl-surface: rgba(255,255,255,.86);
  --fl-surface-strong: rgba(255,255,255,.97);
  --fl-surface-soft: rgba(248,250,252,.92);
  --fl-text: var(--color-text-primary, #15171a);
  --fl-muted: var(--color-text-secondary, #69707d);
  --fl-subtle: var(--color-text-tertiary, #8b94a3);
  --fl-border: var(--color-border-secondary, rgba(18,24,32,.10));
  --fl-border-strong: var(--color-border-primary, rgba(18,24,32,.16));
  --fl-accent: #6d5dfc;
  --fl-accent-2: #4c8dff;
  --fl-success: #11875d;
  --fl-success-bg: rgba(17,135,93,.10);
  --fl-danger: #c33a4a;
  --fl-danger-bg: rgba(195,58,74,.10);
  --fl-warning: #a76b0a;
  --fl-warning-bg: rgba(167,107,10,.11);
  --fl-info: #3769d6;
  --fl-info-bg: rgba(55,105,214,.10);
  --fl-shadow: 0 18px 55px rgba(20,29,43,.10);
  --fl-shadow-soft: 0 8px 30px rgba(20,29,43,.07);
  --fl-radius-xl: 24px;
  --fl-radius-lg: 18px;
  --fl-radius-md: 14px;
  --fl-radius-sm: 10px;
  --fl-logo-image: url("${forgeLinkLogoDataUri}");
  font-family: var(--font-sans, Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
  background: transparent;
  color: var(--fl-text);
  line-height: 1.6;
}
:root[data-theme="dark"] {
  --fl-bg: var(--color-background-primary, #0c0d10);
  --fl-surface: rgba(24,26,31,.84);
  --fl-surface-strong: rgba(28,30,36,.97);
  --fl-surface-soft: rgba(21,23,28,.90);
  --fl-text: var(--color-text-primary, #f5f7fb);
  --fl-muted: var(--color-text-secondary, #a7afbb);
  --fl-subtle: var(--color-text-tertiary, #77808d);
  --fl-border: var(--color-border-secondary, rgba(255,255,255,.09));
  --fl-border-strong: var(--color-border-primary, rgba(255,255,255,.14));
  --fl-accent: #9d8cff;
  --fl-accent-2: #65a2ff;
  --fl-success: #5dd6a5;
  --fl-success-bg: rgba(61,199,146,.12);
  --fl-danger: #ff8290;
  --fl-danger-bg: rgba(255,95,116,.12);
  --fl-warning: #ffc76e;
  --fl-warning-bg: rgba(255,188,77,.12);
  --fl-info: #8db7ff;
  --fl-info-bg: rgba(94,146,255,.12);
  --fl-shadow: 0 22px 70px rgba(0,0,0,.30);
  --fl-shadow-soft: 0 10px 30px rgba(0,0,0,.20);
}
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; }
body {
  padding: 0;
  background: transparent;
  color: var(--fl-text);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
#root { width: 100%; margin: 0; }
.artifact-app {
  position: relative;
  width: min(100%, 1040px);
  margin: 0 auto;
  overflow: visible;
  background: transparent;
  isolation: isolate;
  display: flex;
  flex-direction: column;
  animation: artifactIn .24s ease-out both;
}
.ambient { display: none; }
.hero-top,.brand,.brand-copy,.hero-actions,.hero-status,.hero-status-row,.artifact-toggle-row,.artifact-toggle-button,.metadata-grid,.metadata-chip,.section-heading,.verification-topline,.evidence-reference,.code-language,.limitations-header,.footer-brand,.footer-meta {
  display: flex; align-items: center;
}
.artifact-hero {
  padding: clamp(24px, 4vw, 42px) clamp(18px, 4vw, 36px) clamp(26px, 4vw, 38px);
  border-bottom: 1px solid var(--fl-border);
  background: transparent;
}
.hero-top { justify-content: space-between; gap: 18px; margin-bottom: clamp(34px, 5vw, 58px); }
.brand { gap: 12px; min-width: 0; }
.artifact-logo {
  display: block; width: 32px; height: 32px; flex: 0 0 32px;
  background-image: var(--fl-logo-image);
  background-position: center;
  background-repeat: no-repeat;
  background-size: contain;
  filter: drop-shadow(0 7px 18px color-mix(in srgb, var(--fl-accent) 20%, transparent));
}
.artifact-logo-large { width: 52px; height: 52px; margin-bottom: 6px; }
.brand-copy { gap: 9px; min-width: 0; white-space: nowrap; }
.brand-name { font-size: 14px; font-weight: 760; letter-spacing: -.01em; }
.brand-divider { width: 1px; height: 14px; background: var(--fl-border-strong); }
.document-kind { overflow: hidden; text-overflow: ellipsis; font-size: 12px; color: var(--fl-muted); }
.hero-status {
  gap: 7px; flex: 0 0 auto; min-height: 34px; padding: 7px 11px; border-radius: 999px;
  border: 1px solid var(--fl-border); font-size: 12px; font-weight: 700;
}
.hero-status-success { color: var(--fl-success); background: var(--fl-success-bg); border-color: color-mix(in srgb, var(--fl-success) 26%, var(--fl-border)); }
.hero-status-warning { color: var(--fl-warning); background: var(--fl-warning-bg); border-color: color-mix(in srgb, var(--fl-warning) 26%, var(--fl-border)); }
.hero-actions { gap: 8px; flex: 0 0 auto; justify-content: flex-end; flex-wrap: nowrap; margin-left: auto; }
.artifact-action-button {
  appearance: none; display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 34px; padding: 7px 11px;
  border: 1px solid color-mix(in srgb, var(--fl-accent) 20%, var(--fl-border)); border-radius: 999px;
  background: color-mix(in srgb, var(--fl-accent) 6%, var(--fl-surface-soft)); color: var(--fl-text);
  font: inherit; font-size: 11px; font-weight: 720; cursor: pointer; white-space: nowrap;
  transition: border-color .16s ease, background .16s ease, transform .16s ease, box-shadow .16s ease;
}
.artifact-action-button:hover {
  border-color: color-mix(in srgb, var(--fl-accent) 46%, var(--fl-border));
  background: color-mix(in srgb, var(--fl-accent) 11%, var(--fl-surface-soft));
  box-shadow: 0 6px 18px color-mix(in srgb, var(--fl-accent) 8%, transparent);
}
.artifact-action-button:active { transform: translateY(1px); }
.artifact-action-button:focus-visible,.artifact-toggle-button:focus-visible { outline: 2px solid color-mix(in srgb, var(--fl-accent) 70%, transparent); outline-offset: 2px; }
.artifact-action-button .icon { width: 15px; height: 15px; color: var(--fl-accent); }
.hero-status-row { margin-top: 16px; }
.compact-summary { display: none; }
.artifact-hero { order: 1; }
.artifact-collapsed-preview {
  order: 2; position: relative; display: none; min-height: 142px; max-height: 158px;
  padding: 17px 16px 24px; overflow: hidden; border-top: 1px solid var(--fl-border);
  background: transparent;
}
.preview-kicker {
  margin-bottom: 7px; color: var(--fl-subtle); font-size: 9px; line-height: 1;
  font-weight: 800; letter-spacing: .14em; text-transform: uppercase;
}
.artifact-collapsed-preview h2 {
  margin: 0; color: var(--fl-text); font-size: 15px; line-height: 1.25; letter-spacing: -.01em;
}
.artifact-collapsed-preview p {
  margin: 8px 0 0; color: var(--fl-muted); font-size: 12px; line-height: 1.58;
}
.artifact-preview-fade {
  position: absolute; z-index: 5; left: 0; right: 0; bottom: 0; height: 58px; pointer-events: none;
  background: linear-gradient(180deg,
    transparent 0%,
    color-mix(in srgb, var(--fl-bg) 54%, transparent) 50%,
    var(--fl-bg) 100%);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  mask-image: linear-gradient(to bottom, transparent 0%, rgba(0,0,0,.74) 42%, #000 76%);
  -webkit-mask-image: linear-gradient(to bottom, transparent 0%, rgba(0,0,0,.74) 42%, #000 76%);
}
.workflow-approval-slot { order: 3; padding: 0 16px 8px; }
.workflow-approval-slot:empty { display: none; }
.workflow-approval-card {
  display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 12px;
  padding: 14px; border: 1px solid var(--fl-border); border-radius: var(--fl-radius-md);
  background: color-mix(in srgb, var(--fl-surface-soft) 90%, transparent);
  box-shadow: var(--fl-shadow-soft);
}
.workflow-warning { border-color: color-mix(in srgb, var(--fl-warning) 35%, var(--fl-border)); background: var(--fl-warning-bg); }
.workflow-success { border-color: color-mix(in srgb, var(--fl-success) 32%, var(--fl-border)); background: var(--fl-success-bg); }
.workflow-danger { border-color: color-mix(in srgb, var(--fl-danger) 34%, var(--fl-border)); background: var(--fl-danger-bg); }
.workflow-approval-icon {
  display: grid; place-items: center; width: 38px; height: 38px; border-radius: 12px;
  background: var(--fl-surface-strong); color: var(--fl-accent);
}
.workflow-warning .workflow-approval-icon { color: var(--fl-warning); }
.workflow-success .workflow-approval-icon { color: var(--fl-success); }
.workflow-danger .workflow-approval-icon { color: var(--fl-danger); }
.workflow-approval-copy { min-width: 0; }
.workflow-approval-topline { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.workflow-approval-kicker {
  margin-bottom: 4px; color: var(--fl-subtle); font-size: 9px; font-weight: 820;
  letter-spacing: .14em; text-transform: uppercase;
}
.workflow-approval-copy h3 { margin: 0; color: var(--fl-text); font-size: 14px; line-height: 1.25; }
.workflow-approval-copy p { margin: 7px 0 0; color: var(--fl-muted); font-size: 12px; line-height: 1.5; }
.workflow-status-pill {
  padding: 4px 7px; border: 1px solid var(--fl-border); border-radius: 999px;
  background: var(--fl-surface-strong); color: var(--fl-muted); font-size: 9px; font-weight: 760; white-space: nowrap;
}
.workflow-approval-meta { display: flex; align-items: center; gap: 7px; margin-top: 9px; color: var(--fl-subtle); font-size: 10px; }
.workflow-approval-meta code { max-width: 520px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fl-muted); font-size: 10px; }
.workflow-approval-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.workflow-button {
  display: inline-flex; align-items: center; justify-content: center; gap: 7px;
  min-height: 34px; padding: 7px 11px; border: 1px solid var(--fl-border); border-radius: 10px;
  background: var(--fl-surface-strong); color: var(--fl-text); font: inherit; font-size: 11px; font-weight: 760;
  cursor: pointer;
}
.workflow-button:disabled { opacity: .58; cursor: not-allowed; }
.workflow-button .icon { width: 14px; height: 14px; }
.workflow-approve { border-color: var(--fl-success); color: var(--fl-success); background: var(--fl-success-bg); }
.workflow-decline { border-color: var(--fl-danger); color: var(--fl-danger); }
.workflow-action-error {
  margin-top: 9px; padding: 8px 10px; border: 1px solid var(--fl-danger); border-radius: 9px;
  background: var(--fl-danger-bg); color: var(--fl-danger); font-size: 10px; line-height: 1.45;
}
.workflow-timeline { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--fl-border); }
.workflow-timeline-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 9px; color: var(--fl-subtle); font-size: 9px; font-weight: 820; letter-spacing: .11em; }
.workflow-timeline-heading strong { color: var(--fl-muted); font-size: 9px; letter-spacing: 0; font-weight: 700; }
.workflow-timeline-list { display: grid; gap: 8px; }
.workflow-timeline-item { display: grid; grid-template-columns: 10px minmax(0,1fr); gap: 9px; align-items: start; }
.workflow-timeline-dot { width: 8px; height: 8px; margin-top: 4px; border-radius: 999px; background: var(--fl-subtle); box-shadow: 0 0 0 3px color-mix(in srgb, var(--fl-subtle) 12%, transparent); }
.workflow-timeline-item strong { display: block; color: var(--fl-text); font-size: 10px; line-height: 1.35; }
.workflow-timeline-item p { margin: 2px 0 1px; color: var(--fl-muted); font-size: 10px; line-height: 1.4; }
.workflow-timeline-item div > span { color: var(--fl-subtle); font-size: 9px; }
.timeline-success .workflow-timeline-dot { background: var(--fl-success); box-shadow: 0 0 0 3px color-mix(in srgb, var(--fl-success) 14%, transparent); }
.timeline-active .workflow-timeline-dot { background: var(--fl-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--fl-accent) 14%, transparent); }
.timeline-warning .workflow-timeline-dot { background: var(--fl-warning); box-shadow: 0 0 0 3px color-mix(in srgb, var(--fl-warning) 14%, transparent); }
.timeline-failed .workflow-timeline-dot { background: var(--fl-danger); box-shadow: 0 0 0 3px color-mix(in srgb, var(--fl-danger) 14%, transparent); }
.access-request-app { overflow: hidden; }
.access-request-hero { padding-bottom: 14px; }
.access-request-body { padding: 0 16px 18px; }
.access-request-card {
  display: grid; gap: 12px; padding: 15px; border: 1px solid var(--fl-border);
  border-radius: var(--fl-radius-md); background: var(--fl-surface-soft); box-shadow: var(--fl-shadow-soft);
}
.access-request-row {
  display: grid; grid-template-columns: 86px minmax(0,1fr); align-items: start; gap: 10px;
  padding-bottom: 10px; border-bottom: 1px solid var(--fl-border);
}
.access-request-row:last-of-type { border-bottom: 0; padding-bottom: 0; }
.access-request-row > span {
  color: var(--fl-subtle); font-size: 10px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase;
}
.access-request-row strong { color: var(--fl-text); font-size: 12px; line-height: 1.45; }
.access-request-row code {
  overflow-wrap: anywhere; color: var(--fl-text);
  font: 650 11px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.access-request-reason p { margin: 0; color: var(--fl-muted); font-size: 12px; line-height: 1.55; }
.access-risk-warning {
  display: grid; grid-template-columns: auto minmax(0,1fr); gap: 10px; padding: 11px 12px;
  border: 1px solid color-mix(in srgb, var(--fl-warning) 48%, var(--fl-border));
  border-radius: 11px; background: var(--fl-warning-bg); color: var(--fl-warning);
}
.access-risk-warning .icon { width: 18px; height: 18px; margin-top: 1px; }
.access-risk-warning strong { display: block; font-size: 11px; }
.access-risk-warning span { display: block; margin-top: 2px; color: var(--fl-muted); font-size: 10px; line-height: 1.45; }
.access-request-actions { margin-top: 2px; }
.access-resolution {
  display: flex; align-items: center; gap: 9px; padding: 10px 11px; border-radius: 10px;
  font-size: 11px; line-height: 1.45;
}
.access-resolution-success { color: var(--fl-success); background: var(--fl-success-bg); }
.access-resolution-denied { color: var(--fl-danger); background: var(--fl-danger-bg); }
.access-resolution .icon { width: 16px; height: 16px; flex: 0 0 auto; }

/* Dedicated ChatGPT permission surface: one stable top-to-bottom approval hierarchy. */
.permission-request-app { min-height: 0; display: block; padding: 0; }
.permission-request-body { display: grid; place-items: start center; padding: 10px 0 12px; }
.permission-decision-card {
  display: flex; flex-direction: column; isolation: isolate;
  width: min(100%, 760px); overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--fl-border) 82%, var(--fl-text) 18%);
  border-radius: 16px; background: color-mix(in srgb, var(--fl-surface-soft) 96%, transparent);
  box-shadow: 0 14px 38px rgba(0,0,0,.16), inset 0 1px 0 rgba(255,255,255,.04);
}
.permission-card-head {
  order: 1; display: flex; align-items: flex-start; justify-content: space-between; gap: 18px;
  padding: 19px 18px 17px; border-bottom: 1px solid var(--fl-border);
  background: linear-gradient(180deg, color-mix(in srgb, var(--fl-accent) 5%, var(--fl-surface-strong)) 0%, color-mix(in srgb, var(--fl-surface-soft) 96%, transparent) 100%);
}
.permission-brand-lockup { display: flex; align-items: flex-start; gap: 12px; min-width: 0; }
.permission-brand-lockup .artifact-logo { width: 34px; height: 34px; flex: 0 0 auto; }
.permission-title-copy { min-width: 0; }
.permission-eyebrow {
  display: flex; align-items: center; gap: 7px; margin-bottom: 5px;
  color: var(--fl-subtle); font-size: 9px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase;
}
.permission-eyebrow > span:first-child { color: var(--fl-text); letter-spacing: 0; text-transform: none; font-size: 10px; }
.permission-dot { width: 3px; height: 3px; border-radius: 999px; background: var(--fl-subtle); }
.permission-title-copy h1 { margin: 0; color: var(--fl-text); font-size: 20px; line-height: 1.2; letter-spacing: -.03em; font-weight: 780; text-wrap: balance; }
.permission-title-copy p { margin: 7px 0 0; max-width: 560px; color: var(--fl-muted); font-size: 11px; line-height: 1.55; }
.permission-stage-pill {
  flex: 0 0 auto; padding: 5px 8px;
  border: 1px solid color-mix(in srgb, var(--fl-warning) 34%, var(--fl-border));
  border-radius: 999px; background: color-mix(in srgb, var(--fl-warning-bg) 76%, transparent);
  color: var(--fl-warning); font-size: 9px; font-weight: 800; white-space: nowrap;
}
.permission-summary-grid {
  order: 2; display: grid; grid-template-columns: minmax(0,1fr) minmax(145px,.45fr); gap: 1px;
  margin: 0; background: var(--fl-border); border-bottom: 1px solid var(--fl-border);
}
.permission-summary-item { min-width: 0; padding: 12px 16px; background: color-mix(in srgb, var(--fl-surface-soft) 96%, transparent); }
.permission-summary-wide { grid-column: 1 / -1; }
.permission-summary-item > span, .permission-reason-block > span, .permission-decision-label {
  display: block; margin-bottom: 4px; color: var(--fl-subtle);
  font-size: 9px; font-weight: 820; letter-spacing: .075em; text-transform: uppercase;
}
.permission-summary-item strong { display: block; color: var(--fl-text); font-size: 11px; line-height: 1.4; }
.permission-summary-item code {
  display: block; overflow-wrap: anywhere; color: var(--fl-text);
  font: 650 10px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.permission-duration-item {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 8px;
}
.permission-duration-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.permission-duration-head > span {
  margin-bottom: 0;
}
.permission-duration-value {
  color: var(--fl-accent);
  font-size: 11px;
  font-weight: 750;
}
.permission-duration-pills {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--fl-border) 60%, transparent);
  border: 1px solid var(--fl-border);
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, .05);
}
.permission-duration-pill {
  flex: 1 1 0;
  min-width: 0;
  text-align: center;
  appearance: none;
  border: none;
  outline: none;
  background: transparent;
  color: var(--fl-muted);
  font-family: inherit;
  font-size: 10px;
  font-weight: 650;
  letter-spacing: -.01em;
  padding: 4px 2px;
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
  user-select: none;
  line-height: 1.2;
  transition: all .15s cubic-bezier(.4, 0, .2, 1);
}
.permission-duration-pill:hover:not(:disabled):not(.is-active) {
  color: var(--fl-text);
  background: color-mix(in srgb, var(--fl-surface-strong) 50%, transparent);
}
.permission-duration-pill.is-active {
  color: var(--fl-text);
  background: var(--fl-surface-strong);
  font-weight: 780;
  box-shadow: 0 1px 4px rgba(0, 0, 0, .14), 0 0 0 1px color-mix(in srgb, var(--fl-border-strong) 80%, transparent);
}
.permission-duration-pill:disabled {
  opacity: .5;
  cursor: not-allowed;
}
.permission-reason-block { order: 3; padding: 13px 16px 14px; }
.permission-reason-block p { margin: 0; color: var(--fl-muted); font-size: 11px; line-height: 1.55; }
.permission-impact-card {
  order: 4; display: grid; grid-template-columns: auto minmax(0,1fr); gap: 10px;
  margin: 0 16px 12px; padding: 11px 12px;
  border: 1px solid color-mix(in srgb, var(--fl-warning) 45%, var(--fl-border));
  border-radius: 11px; background: var(--fl-warning-bg); color: var(--fl-warning);
}
.permission-impact-card.is-reviewed {
  border-color: color-mix(in srgb, var(--fl-success) 42%, var(--fl-border));
  background: var(--fl-success-bg); color: var(--fl-success);
}
.permission-impact-card .icon { width: 17px; height: 17px; margin-top: 1px; }
.permission-impact-heading { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.permission-impact-heading strong { color: currentColor; font-size: 10px; }
.permission-impact-heading span { color: var(--fl-subtle); font-size: 9px; font-weight: 700; }
.permission-impact-copy p { margin: 3px 0 0; color: var(--fl-muted); font-size: 10px; line-height: 1.45; }
.permission-decision-card > .workflow-action-error { order: 5; margin: 0 16px 12px; }
.permission-decision-card > .access-resolution { order: 6; margin: 0 16px 12px; }
.permission-continuation-note {
  order: 7; display: grid; grid-template-columns: auto minmax(0,1fr); gap: 9px;
  margin: 0 16px 12px; padding: 9px 11px;
  border: 1px solid color-mix(in srgb, var(--fl-accent) 24%, var(--fl-border));
  border-radius: 10px; background: color-mix(in srgb, var(--fl-accent) 6%, var(--fl-surface-soft));
}
.permission-continuation-note .icon { width: 15px; height: 15px; color: var(--fl-accent); margin-top: 1px; }
.permission-continuation-note strong { display: block; color: var(--fl-text); font-size: 10px; }
.permission-continuation-note span { display: block; margin-top: 2px; color: var(--fl-muted); font-size: 9px; line-height: 1.45; }
.permission-action-footer {
  order: 8; display: flex; align-items: center; justify-content: space-between; gap: 14px;
  padding: 12px 16px 14px; border-top: 1px solid var(--fl-border);
  background: color-mix(in srgb, var(--fl-surface-strong) 46%, transparent);
}
.permission-decision-label { margin: 0; }
.permission-actions { margin: 0; flex-wrap: nowrap; justify-content: flex-end; }
.permission-actions .workflow-button { min-height: 34px; border-radius: 9px; }
.permission-primary {
  min-width: 148px; border-color: color-mix(in srgb, var(--fl-success) 70%, var(--fl-border));
  background: color-mix(in srgb, var(--fl-success-bg) 90%, var(--fl-surface-strong));
  box-shadow: 0 8px 22px color-mix(in srgb, var(--fl-success) 10%, transparent);
}
.permission-deny { background: transparent; }
@media (max-width: 620px) {
  .permission-card-head, .permission-action-footer { align-items: stretch; flex-direction: column; }
  .permission-stage-pill { align-self: flex-start; }
  .permission-summary-grid { grid-template-columns: 1fr; }
  .permission-summary-wide { grid-column: auto; }
  .permission-actions { width: 100%; }
  .permission-actions .workflow-button { flex: 1 1 0; }
  .permission-duration-pills { padding: 3px; gap: 3px; }
  .permission-duration-pill { padding: 6px 3px; font-size: 10.5px; }
}
.maintenance-request-card { border-color: color-mix(in srgb, var(--fl-warning) 30%, var(--fl-border)); }
.maintenance-activating {
  display: grid; grid-template-columns: auto minmax(0,1fr); gap: 10px; padding: 11px 12px;
  border: 1px solid color-mix(in srgb, var(--fl-accent) 40%, var(--fl-border));
  border-radius: 11px; background: color-mix(in srgb, var(--fl-accent) 8%, var(--fl-surface-soft));
}
.maintenance-activating .icon { width: 18px; height: 18px; color: var(--fl-accent); }
.maintenance-activating strong { display: block; color: var(--fl-text); font-size: 11px; }
.maintenance-activating span { display: block; margin-top: 2px; color: var(--fl-muted); font-size: 10px; line-height: 1.45; }
.artifact-toggle-row {
  order: 4; justify-content: flex-start; margin: 0; padding: 8px 16px 4px;
  border-top: 1px solid var(--fl-border);
}
.artifact-toggle-button {
  appearance: none; gap: 8px; min-height: 30px; padding: 5px 0; border: 0; border-radius: 8px;
  background: transparent; color: var(--fl-muted);
  font: inherit; font-size: 11px; font-weight: 730; cursor: pointer;
  transition: color .16s ease, background .16s ease;
}
.artifact-toggle-button:hover { color: var(--fl-text); background: transparent; }
.toggle-icon { display: inline-flex; transition: transform .18s ease; }
.toggle-icon .icon { width: 14px; height: 14px; }
.artifact-expanded-content {
  order: 5; display: none; min-width: 0; max-height: min(70vh, 720px); overflow: auto;
  overscroll-behavior: contain; scrollbar-gutter: stable;
}
.artifact-app.is-expanded .artifact-collapsed-preview { display: none; }
.artifact-app.is-expanded .artifact-toggle-row {
  order: 2; justify-content: flex-end; padding: 9px 16px;
  background: color-mix(in srgb, var(--fl-bg) 88%, transparent);
  backdrop-filter: blur(14px) saturate(135%);
  -webkit-backdrop-filter: blur(14px) saturate(135%);
}
.artifact-app.is-expanded .artifact-toggle-button {
  padding: 5px 8px; border: 1px solid var(--fl-border); border-radius: 999px;
  background: color-mix(in srgb, var(--fl-surface-soft) 82%, transparent);
}
.artifact-app.is-expanded .artifact-expanded-content { display: block; }
.artifact-app.is-expanded .toggle-icon { transform: rotate(180deg); }
.artifact-app.is-collapsed { padding: 0; }
.artifact-app.is-collapsed .artifact-hero {
  padding: 13px 16px 10px; border: 0; border-radius: 0; background: transparent; box-shadow: none;
}
.artifact-app.is-collapsed .hero-top { margin-bottom: 8px; }
.artifact-app.is-collapsed .hero-eyebrow { display: none; }
.artifact-app.is-collapsed .artifact-hero h1 {
  max-width: 780px; font-size: clamp(18px, 3vw, 24px); line-height: 1.2; letter-spacing: -.025em;
}
.artifact-app.is-collapsed .hero-subtitle,
.artifact-app.is-collapsed .metadata-grid,
.artifact-app.is-collapsed .hero-status-row,
.artifact-app.is-collapsed .compact-summary { display: none; }
.artifact-app.is-collapsed .artifact-collapsed-preview { display: block; }
.artifact-app.is-collapsed .artifact-expanded-content { display: none; }
:root[data-display-mode="fullscreen"] .artifact-app { width: min(100%, 1180px); }
:root[data-display-mode="fullscreen"] .artifact-expanded-content { max-height: none; overflow: visible; }
.hero-content { max-width: 900px; }
.hero-eyebrow,.section-kicker {
  font-size: 10px; line-height: 1; font-weight: 800; letter-spacing: .16em; text-transform: uppercase; color: var(--fl-subtle);
}
.hero-eyebrow { margin-bottom: 12px; color: color-mix(in srgb, var(--fl-accent) 76%, var(--fl-muted)); }
.artifact-hero h1 {
  margin: 0; max-width: 930px; font-size: clamp(30px, 5vw, 54px); line-height: 1.04;
  letter-spacing: -.042em; font-weight: 790; text-wrap: balance;
}
.hero-subtitle { max-width: 820px; margin: 16px 0 0; font-size: clamp(15px, 2vw, 18px); line-height: 1.55; color: var(--fl-muted); }
.metadata-grid { flex-wrap: wrap; gap: 8px; margin-top: 28px; }
.metadata-chip {
  gap: 6px; min-height: 30px; padding: 6px 10px; border: 1px solid var(--fl-border); border-radius: 999px;
  background: color-mix(in srgb, var(--fl-surface-strong) 68%, transparent); font-size: 11px;
}
.metadata-key { color: var(--fl-subtle); font-weight: 650; }
.metadata-value { color: var(--fl-text); font-weight: 670; }
.metadata-state { padding-left: 8px; }
.state-dot {
  width: 7px; height: 7px; border-radius: 999px; background: var(--fl-success);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--fl-success) 12%, transparent);
}
.executive-card {
  position: relative; margin: clamp(22px, 3vw, 30px) clamp(18px, 4vw, 36px) 0;
  padding: clamp(20px, 3vw, 28px); overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--fl-accent) 16%, var(--fl-border)); border-radius: var(--fl-radius-lg);
  background: color-mix(in srgb, var(--fl-surface-soft) 94%, transparent);
  box-shadow: none;
}
.executive-accent { position: absolute; inset: 0 auto 0 0; width: 4px; background: linear-gradient(180deg, var(--fl-accent), var(--fl-accent-2)); }
.executive-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.executive-header .icon { color: var(--fl-accent); width: 24px; height: 24px; }
.executive-card h2,.artifact-section h2 {
  margin: 7px 0 0; color: var(--fl-text); font-size: clamp(19px, 2.5vw, 24px); line-height: 1.2; letter-spacing: -.02em;
}
.executive-card p { margin: 18px 0 0; color: var(--fl-muted); font-size: 15px; line-height: 1.75; }
.artifact-content { padding: 0 clamp(18px, 4vw, 36px); }
.artifact-section { padding: clamp(28px, 4vw, 44px) 0; border-bottom: 1px solid var(--fl-border); }
.section-heading { gap: 14px; margin-bottom: 22px; }
.section-heading-spread { justify-content: space-between; align-items: flex-end; gap: 18px; }
.section-number {
  display: grid; place-items: center; width: 36px; height: 36px; flex: 0 0 36px; border: 1px solid var(--fl-border);
  border-radius: 11px; background: var(--fl-surface-soft); color: var(--fl-subtle);
  font: 700 11px/1 var(--font-mono, ui-monospace, monospace);
}
.section-title-group { min-width: 0; }
.section-title-group h2 { margin-top: 6px; }
.section-body { padding-left: 50px; }
.content-block { margin: 15px 0; }
.paragraph-block { color: var(--fl-muted); font-size: 14px; line-height: 1.75; }
.subsection-heading { margin-top: 24px; font-size: 15px; font-weight: 760; color: var(--fl-text); }
.premium-list { list-style: none; padding: 0; margin: 16px 0; display: grid; gap: 10px; }
.premium-list li,.limitations-card li { display: flex; align-items: flex-start; gap: 11px; color: var(--fl-muted); font-size: 14px; line-height: 1.65; }
.list-dot,.limitation-dot {
  width: 6px; height: 6px; flex: 0 0 6px; margin-top: .62em; border-radius: 999px;
  background: linear-gradient(135deg, var(--fl-accent), var(--fl-accent-2));
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--fl-accent) 8%, transparent);
}
.callout-card,.inline-evidence,.walkthrough-card,.limitations-card {
  border: 1px solid var(--fl-border); border-radius: var(--fl-radius-md); background: var(--fl-surface-soft);
}
.callout-card { display: flex; align-items: flex-start; gap: 13px; padding: 17px 18px; }
.callout-icon,.walkthrough-icon {
  display: grid; place-items: center; width: 34px; height: 34px; flex: 0 0 34px; border-radius: 10px;
  color: var(--fl-info); background: var(--fl-info-bg);
}
.callout-title { margin-bottom: 3px; font-size: 13px; font-weight: 760; }
.callout-copy { color: var(--fl-muted); font-size: 13px; line-height: 1.65; }
.quote-block {
  margin-left: 0; padding: 4px 0 4px 18px;
  border-left: 3px solid color-mix(in srgb, var(--fl-accent) 56%, var(--fl-border));
  color: var(--fl-muted); font-size: 14px; font-style: italic;
}
.inline-evidence { display: flex; align-items: flex-start; gap: 10px; padding: 13px 15px; color: var(--fl-muted); font-size: 12px; }
.inline-evidence .icon { color: var(--fl-success); }
.section-divider { height: 1px; margin: 24px 0; background: linear-gradient(90deg, transparent, var(--fl-border-strong), transparent); }
.code-shell {
  overflow: hidden; border: 1px solid var(--fl-border-strong); border-radius: var(--fl-radius-md); background: #0d1017;
  box-shadow: inset 0 1px rgba(255,255,255,.03);
}
.code-header { display: flex; align-items: center; min-height: 38px; padding: 0 14px; border-bottom: 1px solid rgba(255,255,255,.08); background: #131720; }
.code-language { gap: 7px; color: #9ca8b8; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; }
.code-block {
  margin: 0; padding: 17px; overflow: auto; color: #e8edf5;
  font: 12px/1.7 var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  white-space: pre-wrap; word-break: break-word;
}
.engineering-diagram {
  overflow: hidden; border: 1px solid var(--fl-border-strong); border-radius: var(--fl-radius-md);
  background: linear-gradient(145deg, color-mix(in srgb, var(--fl-accent) 6%, var(--fl-surface-soft)), var(--fl-surface-soft));
  box-shadow: var(--fl-shadow-soft);
}
.diagram-header {
  display: flex; align-items: center; gap: 8px; min-height: 40px; padding: 0 14px;
  border-bottom: 1px solid var(--fl-border); color: var(--fl-muted);
  font-size: 10px; font-weight: 800; letter-spacing: .09em; text-transform: uppercase;
}
.diagram-header .icon { width: 15px; height: 15px; color: var(--fl-accent); }
.diagram-flow { display: grid; gap: 7px; padding: 16px; }
.diagram-step { display: grid; justify-items: stretch; gap: 7px; }
.diagram-node {
  padding: 12px 14px; border: 1px solid var(--fl-border); border-radius: 12px;
  background: color-mix(in srgb, var(--fl-surface-strong) 92%, transparent); color: var(--fl-text);
  font-size: 12px; font-weight: 720; line-height: 1.45; text-align: center;
}
.diagram-arrow { display: grid; place-items: center; color: var(--fl-accent); transform: rotate(90deg); }
.diagram-arrow .icon { width: 16px; height: 16px; }
.artifact-image-card {
  overflow: hidden; margin: 0; border: 1px solid var(--fl-border); border-radius: var(--fl-radius-md);
  background: var(--fl-surface-soft); box-shadow: var(--fl-shadow-soft);
}
.artifact-image-card img { display: block; width: 100%; max-height: 620px; object-fit: contain; background: color-mix(in srgb, var(--fl-bg) 92%, transparent); }
.artifact-image-card figcaption { padding: 10px 13px; border-top: 1px solid var(--fl-border); color: var(--fl-muted); font-size: 11px; line-height: 1.5; }
.visual-unavailable { display: flex; align-items: center; gap: 9px; padding: 12px 14px; border: 1px dashed var(--fl-border-strong); border-radius: 12px; color: var(--fl-muted); font-size: 11px; }
.visual-unavailable .icon { color: var(--fl-warning); }
.table-card { overflow: hidden; border: 1px solid var(--fl-border); border-radius: var(--fl-radius-md); background: var(--fl-surface-soft); }
.table-scroll { overflow-x: auto; }
table { width: 100%; min-width: 520px; border-collapse: collapse; font-size: 12px; }
th,td { padding: 12px 14px; text-align: left; vertical-align: top; border-bottom: 1px solid var(--fl-border); }
th {
  color: var(--fl-subtle); background: color-mix(in srgb, var(--fl-surface-strong) 90%, transparent);
  font-size: 10px; letter-spacing: .06em; text-transform: uppercase;
}
td { color: var(--fl-muted); }
tbody tr:last-child td { border-bottom: 0; }
tbody tr:hover td { background: color-mix(in srgb, var(--fl-accent) 3%, transparent); }
.verification-score {
  display: grid; justify-items: end; gap: 2px; padding: 8px 11px; border: 1px solid var(--fl-border);
  border-radius: 12px; background: var(--fl-surface-soft);
}
.score-passed { color: var(--fl-success); }
.score-failed { color: var(--fl-danger); }
.score-value { font-size: 16px; line-height: 1; font-weight: 800; }
.score-label { color: var(--fl-subtle); font-size: 10px; }
.verification-grid,.evidence-grid { display: grid; gap: 10px; }
.verification-card {
  display: grid; grid-template-columns: 38px minmax(0,1fr); gap: 13px; padding: 15px;
  border: 1px solid var(--fl-border); border-radius: var(--fl-radius-md); background: var(--fl-surface-soft);
  transition: border-color .16s ease, transform .16s ease, background .16s ease;
}
.verification-card:hover,.evidence-card:hover { transform: translateY(-1px); border-color: var(--fl-border-strong); }
.verification-pass { border-left: 3px solid color-mix(in srgb, var(--fl-success) 72%, transparent); }
.verification-fail { border-left: 3px solid color-mix(in srgb, var(--fl-danger) 72%, transparent); }
.verification-icon { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 10px; }
.verification-pass .verification-icon { color: var(--fl-success); background: var(--fl-success-bg); }
.verification-fail .verification-icon { color: var(--fl-danger); background: var(--fl-danger-bg); }
.verification-topline { justify-content: space-between; gap: 10px; margin-bottom: 5px; }
.verification-index,.evidence-number { color: var(--fl-subtle); font: 700 10px/1 var(--font-mono, ui-monospace, monospace); }
.verification-content h3,.evidence-body h3 { margin: 0; color: var(--fl-text); font-size: 13px; line-height: 1.45; }
.verification-evidence { margin: 5px 0 0; color: var(--fl-muted); font-size: 12px; line-height: 1.55; }
.status-badge {
  display: inline-flex; align-items: center; min-height: 23px; padding: 4px 8px; border-radius: 999px;
  font-size: 9px; font-weight: 800; letter-spacing: .05em; text-transform: uppercase;
}
.badge-success,.tone-success { color: var(--fl-success); background: var(--fl-success-bg); }
.badge-danger,.tone-danger { color: var(--fl-danger); background: var(--fl-danger-bg); }
.tone-warning { color: var(--fl-warning); background: var(--fl-warning-bg); }
.tone-info { color: var(--fl-info); background: var(--fl-info-bg); }
.tone-neutral { color: var(--fl-muted); background: color-mix(in srgb, var(--fl-muted) 10%, transparent); }
.command-pill {
  display: flex; align-items: center; gap: 7px; width: fit-content; max-width: 100%; margin-top: 10px; padding: 6px 8px;
  overflow: hidden; border-radius: 8px; color: var(--fl-muted); background: color-mix(in srgb, var(--fl-text) 4%, transparent); font-size: 10px;
}
.command-pill code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.section-count { padding: 6px 9px; border: 1px solid var(--fl-border); border-radius: 999px; color: var(--fl-muted); font-size: 10px; }
.evidence-card {
  display: grid; grid-template-columns: 34px minmax(0,1fr); gap: 12px; padding: 15px;
  border: 1px solid var(--fl-border); border-radius: var(--fl-radius-md); background: var(--fl-surface-soft);
  transition: border-color .16s ease, transform .16s ease;
}
.evidence-number { display: grid; place-items: center; width: 32px; height: 32px; border: 1px solid var(--fl-border); border-radius: 9px; }
.evidence-topline { margin-bottom: 7px; }
.evidence-reference { gap: 7px; margin-top: 7px; min-width: 0; color: var(--fl-subtle); font-size: 10px; }
.evidence-reference span:last-child { overflow-wrap: anywhere; }
.walkthrough-card { display: flex; align-items: flex-start; gap: 14px; padding: 18px; }
.walkthrough-icon { color: var(--fl-accent); background: color-mix(in srgb, var(--fl-accent) 11%, transparent); }
.walkthrough-card p { margin: 2px 0 0; color: var(--fl-muted); font-size: 13px; line-height: 1.7; }
.limitations-card {
  padding: 17px 18px; border-color: color-mix(in srgb, var(--fl-warning) 18%, var(--fl-border));
  background: color-mix(in srgb, var(--fl-warning-bg) 42%, var(--fl-surface-soft));
}
.limitations-header { gap: 8px; color: var(--fl-warning); font-size: 11px; font-weight: 760; text-transform: uppercase; letter-spacing: .06em; }
.limitations-card ul { display: grid; gap: 9px; margin: 13px 0 0; padding: 0; list-style: none; }
.limitation-dot { background: var(--fl-warning); box-shadow: 0 0 0 4px color-mix(in srgb, var(--fl-warning) 10%, transparent); }
.artifact-footer {
  display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 20px clamp(18px, 4vw, 36px) 6px;
  color: var(--fl-subtle); background: transparent; font-size: 10px;
}
.footer-brand { gap: 8px; font-weight: 670; color: var(--fl-muted); }
.footer-logo {
  width: 18px; height: 18px; flex: 0 0 18px;
  background-image: var(--fl-logo-image);
  background-position: center;
  background-repeat: no-repeat;
  background-size: contain;
}
.footer-meta { gap: 7px; flex-wrap: wrap; justify-content: flex-end; }
.footer-separator { opacity: .48; }
.icon { display: inline-flex; width: 15px; height: 15px; flex: 0 0 auto; }
.icon svg { width: 100%; height: 100%; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.viewer-state {
  display: grid; justify-items: center; gap: 9px; padding: 56px 24px; border: 1px solid var(--fl-border);
  border-radius: var(--fl-radius-lg); background: color-mix(in srgb, var(--fl-surface-soft) 92%, transparent); color: var(--fl-muted); text-align: center; box-shadow: none;
}
.viewer-state-icon {
  display: grid; place-items: center; width: 46px; height: 46px; margin-bottom: 8px; border-radius: 14px;
  color: var(--fl-accent); background: color-mix(in srgb, var(--fl-accent) 10%, transparent);
}
.viewer-state-icon .icon { width: 22px; height: 22px; }
.viewer-state h2 { margin: 0; color: var(--fl-text); font-size: 20px; }
.viewer-state p { margin: 0; max-width: 480px; font-size: 12px; }
.viewer-state-error .viewer-state-icon { color: var(--fl-danger); background: var(--fl-danger-bg); }
@keyframes artifactIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
/* Professional artifact document surface — v14 */
.artifact-app {
  width: min(100%, 980px);
  border-radius: 16px;
  overflow: hidden;
}
.artifact-hero {
  padding: 20px 20px 22px;
  border-bottom: 1px solid var(--fl-border);
  background: linear-gradient(180deg,
    color-mix(in srgb, var(--fl-surface-strong) 62%, transparent),
    color-mix(in srgb, var(--fl-surface-soft) 34%, transparent));
}
.hero-top { margin-bottom: 20px; }
.brand { gap: 10px; }
.artifact-logo {
  width: 28px; height: 28px; flex-basis: 28px;
  filter: drop-shadow(0 5px 13px color-mix(in srgb, var(--fl-accent) 16%, transparent));
}
.brand-copy { gap: 8px; }
.brand-name { font-size: 13px; font-weight: 740; }
.document-kind {
  max-width: 210px; padding: 3px 7px; overflow: hidden; text-overflow: ellipsis;
  border: 1px solid var(--fl-border); border-radius: 6px;
  background: color-mix(in srgb, var(--fl-surface-soft) 76%, transparent);
  color: var(--fl-muted); font-size: 10px; font-weight: 680;
}
.brand-divider { display: none; }
.hero-actions { gap: 6px; }
.artifact-action-button {
  min-height: 32px; padding: 6px 10px; gap: 6px;
  border-color: var(--fl-border); border-radius: 8px;
  background: color-mix(in srgb, var(--fl-surface-strong) 72%, transparent);
  font-size: 11px; font-weight: 680;
  box-shadow: none;
}
.artifact-action-button:hover {
  border-color: var(--fl-border-strong);
  background: color-mix(in srgb, var(--fl-surface-strong) 94%, transparent);
  box-shadow: 0 4px 14px rgba(0,0,0,.06);
}
.artifact-action-button .icon { width: 14px; height: 14px; color: var(--fl-muted); }
#open-app-tab {
  border-color: color-mix(in srgb, var(--fl-accent) 24%, var(--fl-border));
  background: color-mix(in srgb, var(--fl-accent) 7%, var(--fl-surface-strong));
}
#open-app-tab .icon { color: var(--fl-accent); }
.hero-eyebrow {
  margin-bottom: 8px; font-size: 9px; letter-spacing: .12em;
  color: var(--fl-subtle);
}
.artifact-hero h1 {
  max-width: 860px; font-size: clamp(27px, 4vw, 38px);
  line-height: 1.12; letter-spacing: -.032em; font-weight: 760;
}
.hero-subtitle {
  max-width: 790px; margin: 10px 0 0;
  font-size: 14px; line-height: 1.55; color: var(--fl-muted);
}
.artifact-context-row {
  display: flex; align-items: center; gap: 8px; margin-top: 11px;
  color: var(--fl-subtle); font-size: 10px; font-weight: 650;
}
.context-dot {
  width: 3px; height: 3px; border-radius: 99px;
  background: var(--fl-subtle); opacity: .68;
}
.hero-status-row { margin-top: 12px; }
.hero-status {
  min-height: 28px; padding: 5px 8px; gap: 6px;
  border-radius: 7px; font-size: 10px; font-weight: 700;
}
.hero-status .icon { width: 13px; height: 13px; }
.metadata-grid { gap: 6px; margin-top: 16px; }
.metadata-chip {
  min-height: 28px; padding: 5px 8px; border-radius: 7px;
  background: color-mix(in srgb, var(--fl-surface-strong) 54%, transparent);
  font-size: 10px;
}
.artifact-collapsed-preview {
  min-height: 184px; max-height: 214px; padding: 15px 16px 38px;
  border-top: 1px solid var(--fl-border);
  background: linear-gradient(180deg,
    color-mix(in srgb, var(--fl-surface-soft) 24%, transparent),
    transparent);
}
.preview-kicker {
  margin-bottom: 7px; font-size: 8px; letter-spacing: .12em;
}
.artifact-collapsed-preview h2 {
  font-size: 14px; line-height: 1.3; font-weight: 710;
}
.artifact-collapsed-preview p {
  display: -webkit-box; margin-top: 8px; overflow: hidden;
  -webkit-box-orient: vertical; -webkit-line-clamp: 6;
  color: var(--fl-muted); font-size: 12px; line-height: 1.62;
}
.artifact-preview-fade {
  height: 86px;
  background: linear-gradient(180deg,
    transparent 0%,
    color-mix(in srgb, var(--fl-surface-soft) 48%, transparent) 44%,
    color-mix(in srgb, var(--fl-bg) 94%, var(--fl-surface-soft)) 100%);
  backdrop-filter: blur(3px);
  -webkit-backdrop-filter: blur(3px);
  mask-image: linear-gradient(to bottom, transparent 0%, rgba(0,0,0,.52) 38%, #000 72%);
  -webkit-mask-image: linear-gradient(to bottom, transparent 0%, rgba(0,0,0,.52) 38%, #000 72%);
}
.artifact-toggle-row {
  padding: 0; border-top: 1px solid var(--fl-border);
  background: color-mix(in srgb, var(--fl-surface-soft) 46%, transparent);
}
.artifact-toggle-button {
  width: 100%; min-height: 38px; justify-content: space-between;
  padding: 8px 16px; border-radius: 0;
  color: var(--fl-muted); font-size: 11px; font-weight: 680;
}
.artifact-toggle-button:hover {
  color: var(--fl-text);
  background: color-mix(in srgb, var(--fl-surface-strong) 44%, transparent);
}
.toggle-icon .icon { width: 13px; height: 13px; }
.artifact-app.is-collapsed .artifact-hero {
  padding: 14px 16px 13px;
  border-bottom: 0;
  background: linear-gradient(180deg,
    color-mix(in srgb, var(--fl-surface-strong) 58%, transparent),
    color-mix(in srgb, var(--fl-surface-soft) 18%, transparent));
}
.artifact-app.is-collapsed .hero-top { margin-bottom: 12px; }
.artifact-app.is-collapsed .artifact-logo {
  width: 27px; height: 27px; flex-basis: 27px;
}
.artifact-app.is-collapsed .artifact-hero h1 {
  max-width: 820px; font-size: clamp(18px, 3vw, 22px);
  line-height: 1.25; letter-spacing: -.024em;
}
.artifact-app.is-collapsed .hero-subtitle {
  display: -webkit-box; max-width: 800px; margin-top: 6px; overflow: hidden;
  -webkit-box-orient: vertical; -webkit-line-clamp: 2;
  font-size: 11.5px; line-height: 1.5;
}
.artifact-app.is-collapsed .artifact-context-row { margin-top: 8px; }
.artifact-app.is-collapsed .hero-status-row {
  display: flex; margin-top: 9px;
}
.artifact-app.is-expanded .artifact-hero {
  padding: 20px 22px 22px;
}
.artifact-app.is-expanded .artifact-toggle-row {
  position: sticky; top: 0; z-index: 20; order: 2;
  justify-content: flex-end; padding: 7px 12px;
  border-top: 0; border-bottom: 1px solid var(--fl-border);
  background: color-mix(in srgb, var(--fl-bg) 88%, transparent);
  backdrop-filter: blur(18px) saturate(140%);
  -webkit-backdrop-filter: blur(18px) saturate(140%);
}
.artifact-app.is-expanded .artifact-toggle-button {
  width: auto; min-height: 30px; padding: 5px 9px;
  border: 1px solid var(--fl-border); border-radius: 8px;
  background: color-mix(in srgb, var(--fl-surface-soft) 76%, transparent);
}
.artifact-expanded-content {
  max-height: min(72vh, 760px);
}
.executive-card {
  margin: 18px 20px 0; padding: 20px 21px;
  border-radius: 12px;
}
.executive-card h2,.artifact-section h2 {
  font-size: clamp(18px, 2.2vw, 22px);
}
.executive-card p {
  margin-top: 13px; font-size: 13.5px; line-height: 1.7;
}
.artifact-content { padding: 0 20px; }
.artifact-section { padding: 27px 0; }
.section-heading { gap: 12px; margin-bottom: 17px; }
.section-number {
  width: 31px; height: 31px; flex-basis: 31px; border-radius: 8px;
  font-size: 10px;
}
.section-body { padding-left: 43px; }
.paragraph-block,.premium-list li,.limitations-card li {
  font-size: 13px; line-height: 1.68;
}
.content-block { margin: 12px 0; }
.callout-card { padding: 14px 15px; border-radius: 10px; }
.artifact-footer {
  padding: 16px 20px 8px;
  border-top: 1px solid color-mix(in srgb, var(--fl-border) 68%, transparent);
}

@media (max-width: 720px) {
  body { padding: 0; }
  .artifact-app { width: 100%; }
  .artifact-hero { padding: 23px 20px 26px; }
  .hero-top { align-items: flex-start; margin-bottom: 28px; }
  .hero-actions { align-items: center; flex-direction: row; flex-wrap: nowrap; }
  .artifact-action-button { width: 34px; min-width: 34px; padding: 7px; }
  .artifact-action-button .button-label { display: none; }
  .document-kind,.brand-divider { display: none; }
  .hero-status { max-width: 100%; }
  .artifact-hero h1 { font-size: clamp(28px, 9vw, 42px); }
  .executive-card { margin: 14px 14px 0; padding: 20px; }
  .artifact-content { padding: 0 15px; }
  .artifact-section { padding: 28px 0; }
  .section-body { padding-left: 0; }
  .section-heading { align-items: flex-start; }
  .section-number { display: none; }
  .section-heading-spread { align-items: flex-start; }
  .verification-score { min-width: 76px; }
  .artifact-footer { align-items: flex-start; flex-direction: column; }
  .footer-meta { justify-content: flex-start; }
}
@media (max-width: 470px) {
  .hero-top { gap: 10px; }
  .hero-actions { gap: 5px; }
  .artifact-action-button { width: 31px; min-width: 31px; min-height: 31px; padding: 6px; }
  .brand-name { font-size: 13px; }
  .hero-status { min-height: 30px; padding: 6px 8px; font-size: 10px; }
  .metadata-grid { gap: 6px; }
  .metadata-chip { max-width: 100%; }
  .metadata-value { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .verification-card,.evidence-card { grid-template-columns: 1fr; }
  .verification-icon,.evidence-number { display: none; }
  table { min-width: 460px; }
}
@media (prefers-reduced-motion: reduce) {
  .artifact-app { animation: none; }
  .verification-card,.evidence-card { transition: none; }
}
@media print {
  body { padding: 0; background: #fff; }
  .artifact-app { width: 100%; }
  .ambient,.artifact-action-button,.artifact-toggle-row,.compact-summary { display: none !important; }
  .artifact-preview-fade,.artifact-toggle-row,.artifact-collapsed-preview { display: none !important; }
  .artifact-expanded-content { display: block !important; max-height: none !important; overflow: visible !important; }
  .artifact-app.is-collapsed .artifact-expanded-content { display: block !important; }
  .artifact-app.is-collapsed .metadata-grid { display: flex; }
  .artifact-app.is-collapsed .hero-eyebrow { display: block; }
  .artifact-app.is-collapsed .artifact-hero { padding: 28px 24px; border: 0; border-radius: 0; box-shadow: none; background: transparent; }
  .artifact-app.is-collapsed .artifact-hero h1 { font-size: 32px; }
}
.artifact-content.natural-content-host {
  padding: clamp(24px, 4vw, 48px) clamp(18px, 5vw, 58px) clamp(54px, 7vw, 80px);
}
.natural-document {
  width: min(100%, 820px);
  margin: 0 auto;
  color: var(--fl-text);
  font-size: 15px;
  line-height: 1.78;
  letter-spacing: -.003em;
}
.natural-document > :first-child { margin-top: 0; }
.natural-document > :last-child { margin-bottom: 0; }
.natural-document p { margin: 0 0 1.15em; color: color-mix(in srgb, var(--fl-text) 86%, var(--fl-muted)); }
.natural-document .natural-heading {
  margin: 2.15em 0 .72em;
  color: var(--fl-text);
  font-weight: 780;
  letter-spacing: -.025em;
  line-height: 1.18;
}
.natural-document .natural-heading-2 { font-size: clamp(22px, 3vw, 29px); }
.natural-document .natural-heading-3 { font-size: clamp(18px, 2.4vw, 22px); margin-top: 1.8em; }
.natural-document .natural-heading-4 { font-size: 16px; margin-top: 1.55em; }
.natural-document ul,
.natural-document ol { margin: .25em 0 1.3em; padding-left: 1.45em; }
.natural-document li { margin: .42em 0; padding-left: .18em; }
.natural-document li::marker { color: var(--fl-accent); }
.natural-document blockquote {
  margin: 1.35em 0 1.55em;
  padding: .15em 0 .15em 1.15em;
  border-left: 3px solid color-mix(in srgb, var(--fl-accent) 58%, var(--fl-border));
  color: var(--fl-muted);
  font-size: .97em;
}
.natural-document blockquote p:last-child { margin-bottom: 0; }
.natural-document hr { border: 0; border-top: 1px solid var(--fl-border); margin: 2.2em 0; }
.natural-document a { color: var(--fl-info); text-decoration-thickness: 1px; text-underline-offset: 3px; }
.natural-document code:not(.code-block code) {
  padding: .16em .38em;
  border-radius: 6px;
  background: color-mix(in srgb, var(--fl-accent) 7%, var(--fl-surface-soft));
  border: 1px solid var(--fl-border);
  font-size: .9em;
}
.natural-document table {
  width: 100%;
  margin: 1.35em 0 1.75em;
  border-collapse: separate;
  border-spacing: 0;
  border: 1px solid var(--fl-border);
  border-radius: 12px;
  overflow: hidden;
  font-size: 13px;
}
.natural-document th,
.natural-document td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--fl-border);
  vertical-align: top;
  text-align: left;
}
.natural-document th {
  background: color-mix(in srgb, var(--fl-accent) 5%, var(--fl-surface-soft));
  color: var(--fl-text);
  font-weight: 720;
}
.natural-document tr:last-child td { border-bottom: 0; }
.natural-document .natural-code { margin: 1.35em 0 1.6em; }
.natural-image { margin: 1.5em 0 1.8em; }
.natural-image img { display: block; max-width: 100%; height: auto; margin: 0 auto; border-radius: 14px; }
.natural-private-image img:not([src]) { width: min(180px, 46vw); aspect-ratio: 1; background: color-mix(in srgb, var(--fl-accent) 6%, var(--fl-surface-soft)); border: 1px solid var(--fl-border); }
.natural-image-load-failed { padding: 14px; border: 1px dashed var(--fl-border); border-radius: 12px; text-align: center; }
.natural-image figcaption { margin-top: 8px; color: var(--fl-muted); font-size: 12px; text-align: center; }
.natural-link-blocked,
.natural-image-unavailable { color: var(--fl-muted); text-decoration: none; }
.markdown-literal-html { white-space: pre-wrap; }

/* Professional report chrome — v19 */
.artifact-app {
  width: min(100%, 1040px);
  overflow: hidden;
  border-radius: 18px;
  background: color-mix(in srgb, var(--fl-bg) 97%, var(--fl-surface-soft));
  box-shadow: 0 22px 60px rgba(0,0,0,.16), inset 0 0 0 1px color-mix(in srgb, var(--fl-border) 74%, transparent);
}
.artifact-hero {
  padding: 18px 24px 24px;
  border-bottom: 1px solid color-mix(in srgb, var(--fl-border) 80%, transparent);
  background:
    radial-gradient(circle at 82% 8%, color-mix(in srgb, var(--fl-accent) 8%, transparent), transparent 28%),
    linear-gradient(180deg, color-mix(in srgb, var(--fl-surface-strong) 72%, var(--fl-bg)), color-mix(in srgb, var(--fl-bg) 96%, var(--fl-surface-soft)));
}
.hero-top {
  margin-bottom: 22px;
  padding-bottom: 14px;
  border-bottom: 1px solid color-mix(in srgb, var(--fl-border) 66%, transparent);
}
.artifact-logo { width: 30px; height: 30px; flex-basis: 30px; }
.brand-name { font-size: 13px; font-weight: 780; }
.document-kind {
  padding: 4px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--fl-accent) 5%, var(--fl-surface-soft));
  color: var(--fl-muted);
  font-size: 9.5px;
  letter-spacing: .02em;
}
.hero-actions { gap: 7px; }
.artifact-action-button {
  min-height: 34px;
  padding: 7px 10px;
  border-radius: 9px;
  background: color-mix(in srgb, var(--fl-surface-strong) 86%, transparent);
  box-shadow: 0 2px 9px rgba(0,0,0,.04);
}
#download-pdf {
  border-color: color-mix(in srgb, var(--fl-success) 26%, var(--fl-border));
  background: color-mix(in srgb, var(--fl-success) 6%, var(--fl-surface-strong));
}
#download-pdf .icon { color: var(--fl-success); }
.hero-content { max-width: 900px; }
.hero-eyebrow {
  display: inline-flex;
  width: fit-content;
  margin-bottom: 10px;
  padding: 4px 7px;
  border: 1px solid color-mix(in srgb, var(--fl-accent) 18%, var(--fl-border));
  border-radius: 999px;
  background: color-mix(in srgb, var(--fl-accent) 5%, transparent);
  color: var(--fl-accent);
  font-size: 8px;
  letter-spacing: .14em;
}
.artifact-hero h1 {
  max-width: 900px;
  font-size: clamp(29px, 4vw, 41px);
  line-height: 1.08;
  letter-spacing: -.036em;
  font-weight: 790;
}
.hero-subtitle {
  max-width: 830px;
  margin-top: 10px;
  color: color-mix(in srgb, var(--fl-text) 70%, var(--fl-muted));
  font-size: 13.5px;
  line-height: 1.62;
}
.artifact-context-row {
  width: fit-content;
  margin-top: 14px;
  padding: 7px 10px;
  border: 1px solid var(--fl-border);
  border-radius: 9px;
  background: color-mix(in srgb, var(--fl-surface-soft) 78%, transparent);
  color: var(--fl-muted);
}
.metadata-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, max-content));
  gap: 8px 18px;
  margin-top: 15px;
}
.metadata-chip {
  display: flex;
  align-items: baseline;
  gap: 7px;
  min-height: 0;
  padding: 3px 0 3px 9px;
  border: 0;
  border-left: 2px solid color-mix(in srgb, var(--fl-accent) 34%, var(--fl-border));
  border-radius: 0;
  background: transparent;
}
.metadata-key {
  color: var(--fl-subtle);
  font-size: 8px;
  font-weight: 800;
  letter-spacing: .08em;
  text-transform: uppercase;
}
.metadata-value {
  color: var(--fl-muted);
  font-size: 10.5px;
  font-weight: 650;
}
.artifact-expanded-content { max-height: min(78vh, 920px); }
.artifact-content.natural-content-host {
  padding: clamp(28px, 4vw, 50px) clamp(20px, 5vw, 60px) 30px;
}
.natural-document { width: min(100%, 840px); }
.natural-image,
.artifact-chart-card { margin: 1.8em 0 2em; }
.natural-image {
  max-width: 100%;
}
.natural-image img {
  display: block;
  width: auto;
  max-width: 100%;
  max-height: 640px;
  object-fit: contain;
  box-shadow: 0 12px 34px rgba(0,0,0,.10);
}
.natural-image-role-logo {
  width: fit-content;
  max-width: min(96px, 20vw);
  margin: 18px 0 26px;
  padding: 0;
  border: 0;
  background: transparent;
  box-shadow: none;
}
.natural-image-role-logo img {
  width: auto;
  max-width: min(82px, 17vw);
  max-height: 82px;
  border-radius: 14px;
  box-shadow: none;
}
.natural-image-role-logo figcaption { display: none; }
.natural-image-role-screenshot {
  position: relative;
  width: 100%;
  max-width: 840px;
  margin-left: auto;
  margin-right: auto;
  padding: 28px 8px 8px;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--fl-border) 92%, transparent);
  border-radius: 16px;
  background: color-mix(in srgb, var(--fl-surface-strong) 92%, var(--fl-bg));
  box-shadow: 0 18px 44px rgba(0,0,0,.14);
}
.natural-image-role-screenshot::before {
  content: "●  ●  ●     APP SCREENSHOT";
  position: absolute;
  inset: 0 0 auto;
  height: 26px;
  display: flex;
  align-items: center;
  padding: 0 10px;
  border-bottom: 1px solid var(--fl-border);
  color: var(--fl-subtle);
  font-size: 8px;
  font-weight: 800;
  letter-spacing: .09em;
}
.natural-image-role-screenshot img {
  width: 100%;
  max-height: 720px;
  border-radius: 10px;
  box-shadow: none;
}
.natural-image-role-diagram {
  width: min(100%, 780px);
  margin-left: auto;
  margin-right: auto;
  padding: 14px;
  border: 1px solid var(--fl-border);
  border-radius: 14px;
  background: color-mix(in srgb, var(--fl-surface-soft) 82%, transparent);
}
.natural-image-role-diagram img { max-height: 620px; margin: 0 auto; box-shadow: none; }
.natural-image-role-photo {
  width: min(100%, 760px);
  margin-left: auto;
  margin-right: auto;
}
.natural-image-role-photo img { width: 100%; border-radius: 16px; }
.natural-image-role-generic {
  width: min(100%, 760px);
  margin-left: auto;
  margin-right: auto;
}
.natural-private-image img:not([src]),
.natural-web-image img:not([src]) {
  width: min(220px, 55vw);
  aspect-ratio: 16 / 10;
  background:
    linear-gradient(110deg, transparent 22%, color-mix(in srgb, var(--fl-accent) 6%, var(--fl-surface-strong)) 40%, transparent 58%),
    color-mix(in srgb, var(--fl-surface-soft) 88%, transparent);
  background-size: 220% 100%;
}
.artifact-chart-card {
  overflow: hidden;
  border: 1px solid var(--fl-border);
  border-radius: 14px;
  background: color-mix(in srgb, var(--fl-surface-soft) 86%, transparent);
  box-shadow: var(--fl-shadow-soft);
}
.artifact-chart-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  padding: 16px 18px 8px;
}
.artifact-chart-header h3 { margin: 5px 0 0; font-size: 16px; }
.artifact-chart-header p { margin: 5px 0 0; font-size: 11.5px; color: var(--fl-muted); }
.artifact-chart { display: block; width: 100%; height: auto; padding: 0 8px 8px; overflow: visible; }
.chart-grid line { stroke: var(--fl-border); stroke-width: 1; }
.chart-grid text,.chart-axis-label { fill: var(--fl-subtle); font-size: 10px; }
.chart-axis { stroke: var(--fl-border-strong); stroke-width: 1.2; }
.chart-line { fill: none !important; stroke-width: 3; stroke-linejoin: round; stroke-linecap: round; }
.chart-series-0 { fill: var(--fl-accent); stroke: var(--fl-accent); }
.chart-series-1 { fill: var(--fl-info); stroke: var(--fl-info); }
.chart-series-2 { fill: var(--fl-success); stroke: var(--fl-success); }
.chart-series-3 { fill: var(--fl-warning); stroke: var(--fl-warning); }
.chart-legend { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 7px 12px; color: var(--fl-muted); font-size: 10px; }
.chart-legend span { display: inline-flex; align-items: center; gap: 5px; }
.chart-swatch { width: 8px; height: 8px; border-radius: 3px; }
.artifact-footer {
  display: grid;
  grid-template-columns: minmax(0,1fr) auto;
  align-items: center;
  gap: 20px;
  margin: 0;
  padding: 18px 22px;
  border-top: 1px solid color-mix(in srgb, var(--fl-border) 80%, transparent);
  background: linear-gradient(180deg, color-mix(in srgb, var(--fl-surface-soft) 54%, transparent), color-mix(in srgb, var(--fl-surface-strong) 72%, var(--fl-bg)));
  color: var(--fl-subtle);
}
.footer-brand { align-items: center; gap: 10px; }
.footer-logo { width: 22px; height: 22px; flex-basis: 22px; }
.footer-brand-copy { display: grid; gap: 2px; }
.footer-brand-copy strong { color: var(--fl-text); font-size: 10.5px; font-weight: 760; }
.footer-brand-copy span { color: var(--fl-subtle); font-size: 8.5px; }
.footer-meta {
  justify-content: flex-end;
  gap: 7px;
  color: var(--fl-muted);
  font-size: 9px;
}
@media (max-width: 720px) {
  .artifact-hero { padding: 16px 16px 20px; }
  .hero-top { margin-bottom: 18px; padding-bottom: 12px; }
  .metadata-grid { grid-template-columns: 1fr 1fr; }
  .artifact-chart-header { flex-direction: column; }
  .chart-legend { justify-content: flex-start; }
  .artifact-footer { grid-template-columns: 1fr; gap: 12px; }
  .footer-meta { justify-content: flex-start; }
}
</style>
</head>
<body>
<main id="root"><div class="viewer-state"><div class="section-kicker">FORGELINK ARTIFACT</div><h2>Loading artifact…</h2></div></main>
<script type="module">${clientBundle}</script>
</body>
</html>`;
